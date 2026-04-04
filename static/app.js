/* ============================================================
   SRT 字幕翻译工作台 - 前端逻辑
   ============================================================ */

// ==================== Global State ====================
const AppState = {
    subtitles: [],
    originalFileName: '',
    currentStep: 1,
    subtitleLang: 'unknown',
    mergeMode: 'words',    // 'words' for Latin, 'chars' for CJK/Korean
    // AI tab
    correctionVersion: 0,
    aiSuggestions: [],
    ignoredSuggestions: new Set(),
    changeLocations: [],
    currentNavIndex: -1,
    // Manual merge
    mergeTargets: [],
    mergeCurrentIndex: 0,
    mergedSubtitles: [],
    markedSubtitles: [],
    // Editor
    editorSearchResults: [],
    editorResultIndex: 0,
    modifiedSubtitles: new Set(),
    // Quality check results for clipboard
    ccProblemIndices: [],
    dcProblemIndices: [],
    // Preview search
    previewSearchResults: [],
    previewSearchResultIndex: 0,
};

// ==================== SRT Parser & Serializer ====================
function parseSRT(content) {
    const results = [];
    content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = content.trim().split(/\n\s*\n/);
    blocks.forEach(block => {
        const lines = block.trim().split('\n');
        if (lines.length < 3) return;
        const number = parseInt(lines[0]);
        if (isNaN(number)) return;
        const timeLine = lines[1];
        const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
        if (!timeMatch) return;
        const text = lines.slice(2).join('\n');
        results.push({
            index: number,
            startTime: timeMatch[1],
            endTime: timeMatch[2],
            text: text,
            originalText: text,
            originalStartTime: timeMatch[1],
            originalEndTime: timeMatch[2],
            sourceText: '',
            translationText: ''
        });
    });
    return results;
}

function serializeSRT(subs) {
    return subs.map((s, i) =>
        `${i + 1}\n${s.startTime} --> ${s.endTime}\n${s.text}\n`
    ).join('\n');
}

function reindexSubtitles() {
    AppState.subtitles.forEach((s, i) => { s.index = i + 1; });
}

// ==================== Helpers ====================
function timeToSeconds(timeStr) {
    const parts = timeStr.replace(',', '.').split(':');
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
}

function secondsToTimeStr(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function formatDurationHMS(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function isChinese(text) { return /[\u4e00-\u9fa5]/.test(text); }
function countChineseChars(text) { return (text.match(/[\u4e00-\u9fa5]/g) || []).length; }
function escapeRegExp(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isTranslationLine(text) {
    // 判断是否为中文译文行：中文字符占比超过 50%
    const chars = text.replace(/\s/g, '');
    if (!chars.length) return false;
    const cn = (chars.match(/[\u4e00-\u9fa5]/g) || []).length;
    return cn / chars.length > 0.5;
}

function groupLinesByLanguage(text) {
    const lines = text.split('\n');
    const groups = { source: [], translation: [] };
    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (isTranslationLine(trimmed)) groups.translation.push(trimmed);
        else groups.source.push(trimmed);
    });
    return groups;
}

function mergeTextByLanguage(sub1, sub2) {
    // 字段分离方案：优先使用 sourceText/translationText 字段
    if (sub1.sourceText && sub2.sourceText) {
        const isCJK = (AppState.mergeMode === 'chars');
        const srcJoiner = ' ';
        const trlJoiner = isCJK ? '' : ' ';
        const src = sub1.sourceText + srcJoiner + sub2.sourceText;
        const trl = [sub1.translationText, sub2.translationText].filter(Boolean).join(trlJoiner);
        const lines = [];
        if (src) lines.push(src);
        if (trl) lines.push(trl);
        return { text: lines.join('\n'), sourceText: src, translationText: trl };
    }
    // Fallback：未经本工具翻译的字幕，用旧逻辑按语言检测分组
    const t1 = typeof sub1 === 'string' ? sub1 : sub1.text;
    const t2 = typeof sub2 === 'string' ? sub2 : sub2.text;
    const g1 = groupLinesByLanguage(t1);
    const g2 = groupLinesByLanguage(t2);
    const isCJK = (AppState.mergeMode === 'chars');
    const joiner = isCJK ? '' : ' ';
    const src = [...g1.source, ...g2.source].join(joiner);
    const trl = [...g1.translation, ...g2.translation].join(joiner);
    const lines = [];
    if (src) lines.push(src);
    if (trl) lines.push(trl);
    return { text: lines.join('\n'), sourceText: src, translationText: trl };
}

function showToast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.style.background = type === 'error' ? 'var(--danger)' : 'var(--success)';
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

function showLoading(show, text) {
    const el = document.getElementById('overlay');
    el.style.display = show ? 'flex' : 'none';
    if (text) document.getElementById('loadingText').textContent = text;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ==================== Global Prompts UI ====================
let globalPromptsData = [];

function renderGlobalPromptsUI() {
    const list = document.getElementById('cfgGlobalPromptsList');
    if (!list) return;
    list.innerHTML = globalPromptsData.map((p, i) => `
        <div style="background:var(--bg-secondary,#f8f9fa);border:1px solid var(--border,#dee2e6);border-radius:6px;padding:8px;position:relative">
            <button type="button" onclick="removeGlobalPromptUI(${i})" style="position:absolute;top:5px;right:5px;background:none;border:none;color:var(--danger,#dc3545);cursor:pointer;font-size:1.2em" title="删除">&times;</button>
            <div style="margin-bottom:6px">
                <label style="font-size:0.85em;font-weight:600">角色：</label>
                <select class="input-sm" onchange="globalPromptsData[${i}].role = this.value">
                    <option value="system" ${p.role==='system'?'selected':''}>system (系统)</option>
                    <option value="user" ${p.role==='user'?'selected':''}>user (用户)</option>
                    <option value="assistant" ${p.role==='assistant'||p.role==='ai'?'selected':''}>assistant (AI)</option>
                </select>
            </div>
            <div>
                <textarea class="textarea" style="height:60px;font-size:0.85em" placeholder="提示词内容" onchange="globalPromptsData[${i}].content = this.value">${escapeHtml(p.content||'')}</textarea>
            </div>
        </div>
    `).join('');
}

function addGlobalPromptUI() {
    globalPromptsData.push({ role: 'system', content: '' });
    renderGlobalPromptsUI();
}

function removeGlobalPromptUI(index) {
    globalPromptsData.splice(index, 1);
    renderGlobalPromptsUI();
}

// ==================== Tab Switching ====================
function switchTab(n) {
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.getElementById(`tab-${n}`).style.display = 'block';
    document.querySelector(`.step[data-step="${n}"]`).classList.add('active');
    AppState.currentStep = n;
    if (n === 4) refreshDownloadTab();
}

// ==================== Tab 1: 导入文件 ====================
document.addEventListener('DOMContentLoaded', () => {
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');

    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', e => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) handleUnifiedUpload(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', e => {
        if (e.target.files[0]) handleUnifiedUpload(e.target.files[0]);
        fileInput.value = '';
    });

    loadConfig();

    // 全局监听：任何步骤修改字幕后，编辑器自动同步
    document.addEventListener('subtitlesChanged', () => {
        const panel = document.getElementById('editorPanel');
        if (panel.classList.contains('open') && AppState.subtitles.length > 0) {
            editorRender(AppState.subtitles);
        }
    });
});

const VIDEO_AUDIO_EXTS = new Set(['mp4','mkv','mov','avi','flv','webm','mp3','wav','m4a','flac','aac','ogg','wma']);

function handleUnifiedUpload(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'srt') {
        document.getElementById('transcribePanel').style.display = 'none';
        handleFileUpload(file);
    } else if (VIDEO_AUDIO_EXTS.has(ext)) {
        document.getElementById('uploadStats').style.display = 'none';
        document.getElementById('uploadNext').style.display = 'none';
        window.setTranscribeFile(file);
    } else {
        showToast('不支持的文件格式，请上传 SRT 或音视频文件', 'error');
    }
}

function handleFileUpload(file) {
    AppState.originalFileName = file.name;
    const reader = new FileReader();
    reader.onload = e => {
        AppState.subtitles = parseSRT(e.target.result);
        if (AppState.subtitles.length === 0) { showToast('解析 SRT 失败', 'error'); return; }
        reindexSubtitles();
        // Reset states
        AppState.correctionVersion = 0;
        AppState.aiSuggestions = [];
        AppState.ignoredSuggestions.clear();
        AppState.modifiedSubtitles.clear();
        // Auto-detect language and set merge defaults (also triggers previewMerge)
        AppState.subtitleLang = detectSubtitleLanguage(AppState.subtitles);
        setMergeDefaults(AppState.subtitleLang);

        document.getElementById('statTotal').textContent = AppState.subtitles.length;
        const last = AppState.subtitles[AppState.subtitles.length - 1];
        document.getElementById('statDuration').textContent = formatDurationHMS(timeToSeconds(last.endTime));
        document.getElementById('statFileName').textContent = AppState.originalFileName;
        document.getElementById('uploadStats').style.display = '';
        document.getElementById('uploadNext').style.display = '';
        document.querySelector('.step[data-step="1"]').classList.add('completed');

        document.getElementById('oneclickBtn').disabled = false;
        showToast(`已加载 ${AppState.subtitles.length} 条字幕`);
        document.dispatchEvent(new CustomEvent('subtitlesChanged'));
    };
    reader.readAsText(file, 'UTF-8');
}

// ==================== Tab 2: Short Sentence Merge ====================

function detectSubtitleLanguage(subtitles) {
    const sample = subtitles.slice(0, Math.min(60, subtitles.length)).map(s => s.text).join('');
    const nonSpace = sample.replace(/\s/g, '');
    if (!nonSpace.length) return 'unknown';
    const cjk     = (sample.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3041-\u3096\u30a1-\u30fc]/g) || []).length;
    const hangul   = (sample.match(/[\uac00-\ud7a3\u1100-\u11ff]/g) || []).length;
    const latin    = (sample.match(/[a-zA-Z]/g) || []).length;
    const total    = nonSpace.length;
    if ((cjk + hangul) / total > 0.25) return hangul > cjk ? 'korean' : 'cjk';
    if (latin / total > 0.25) return 'latin';
    return 'unknown';
}

function setMergeDefaults(lang) {
    const slider  = document.getElementById('mergeMaxWords');
    const badge   = document.getElementById('mergeMaxWordsVal');
    const label   = document.getElementById('mergeLimitLabel');
    const hint    = document.getElementById('detectedLang');

    const isCJK = lang === 'cjk' || lang === 'korean';
    AppState.mergeMode = isCJK ? 'chars' : 'words';

    const langNames = { cjk: '中文 / 日文', korean: '韩文', latin: '英文 / 拉丁语', unknown: '英文 / 拉丁语（默认）' };
    if (hint) hint.textContent = langNames[lang] || '未知';

    if (isCJK) {
        if (label) label.textContent = '判定为短句的最大字符数：';
        slider.min = 2; slider.max = 30; slider.value = 5; badge.textContent = 5;
    } else {
        if (label) label.textContent = '判定为短句的最大单词数：';
        slider.min = 1; slider.max = 15; slider.value = 3; badge.textContent = 3;
    }
    previewMerge();
}

function previewMerge() {
    if (AppState.subtitles.length === 0) return;
    const maxVal = parseInt(document.getElementById('mergeMaxWords').value);
    const copy = AppState.subtitles.map(s => ({ ...s }));
    performEnglishMerge(copy, maxVal);
    const before = AppState.subtitles.length;
    const after = copy.length;
    document.getElementById('mergeBefore').textContent = before;
    document.getElementById('mergeAfter').textContent = after;
    document.getElementById('mergeDiff').textContent = before - after;
}

function runEnglishMerge() {
    if (AppState.subtitles.length === 0) { showToast('请先上传文件', 'error'); return; }
    const before = AppState.subtitles.length;
    const maxChars = parseInt(document.getElementById('mergeMaxWords').value);
    performEnglishMerge(AppState.subtitles, maxChars);
    reindexSubtitles();
    const after = AppState.subtitles.length;

    document.getElementById('mergeBefore').textContent = before;
    document.getElementById('mergeAfter').textContent = after;
    document.getElementById('mergeDiff').textContent = before - after;
    document.querySelector('.step[data-step="2"]').classList.add('completed');

    showToast(`已合并 ${before - after} 个碎片，进入下一步`);
    document.dispatchEvent(new CustomEvent('subtitlesChanged'));
    switchTab(3);
}

function performEnglishMerge(subs, maxVal) {
    // Use mergeMode from AppState (set by language detection)
    const isCJK = AppState.mergeMode === 'chars';
    const joiner = isCJK ? '' : ' ';
    const sentenceEndRe = isCJK ? /[。！？…]["']?$/ : /[.!?]["']?$/;

    function getCount(text) {
        if (isCJK) return text.replace(/\s+/g, '').length;
        return text.trim().split(/\s+/).filter(w => w.length > 0).length;
    }

    function timeToSec(t) {
        const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
        if (!m) return 0;
        return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
    }
    const GAP_LIMIT = 1.0; // 间隔超过1秒不合并

    let i = 0;
    while (i < subs.length) {
        const text = subs[i].text.trim();
        const count = getCount(text);
        if (count > 0 && count <= maxVal) {
            const gapToPrev = i > 0 ? timeToSec(subs[i].startTime) - timeToSec(subs[i - 1].endTime) : Infinity;
            const gapToNext = i < subs.length - 1 ? timeToSec(subs[i + 1].startTime) - timeToSec(subs[i].endTime) : Infinity;
            let mergeWithPrev = false, mergeWithNext = false;
            if (i > 0 && i < subs.length - 1) {
                if (!sentenceEndRe.test(subs[i - 1].text.trim()) && gapToPrev < GAP_LIMIT) mergeWithPrev = true;
                else if (gapToNext < GAP_LIMIT) mergeWithNext = true;
            } else if (i > 0 && gapToPrev < GAP_LIMIT) {
                mergeWithPrev = true;
            } else if (i < subs.length - 1 && gapToNext < GAP_LIMIT) {
                mergeWithNext = true;
            }
            if (mergeWithPrev) {
                subs[i - 1].text += joiner + text;
                subs[i - 1].endTime = subs[i].endTime;
                subs.splice(i, 1);
                continue;
            } else if (mergeWithNext) {
                subs[i + 1].text = text + joiner + subs[i + 1].text;
                subs[i + 1].startTime = subs[i].startTime;
                subs.splice(i, 1);
                continue;
            }
        }
        i++;
    }
}

// ==================== Tab 3: AI Correction & Translation ====================
function updateVersionDisplay() {
    document.getElementById('versionDisplay').textContent = `v${AppState.correctionVersion}`;
}

async function runAIAnalysis() {
    if (AppState.subtitles.length === 0) { showToast('请先上传文件', 'error'); return; }
    const content = serializeSRT(AppState.subtitles);
    const videoBg = document.getElementById('videoBgInput').value.trim();
    const template = AppState.defaultPromptTemplate || '';
    const prompt = template.includes('【复制粘贴视频的标题和简介】')
        ? template.replace('【复制粘贴视频的标题和简介】', videoBg || '（未提供）')
        : template + (videoBg ? '\n视频背景：' + videoBg : '');
    showLoading(true, `正在分析 v${AppState.correctionVersion}...`);
    document.getElementById('tokenStatAnalysis').style.display = 'none';
    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, prompt })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        showTokenStats('tokenStatAnalysis', data.usage);
        const parsed = JSON.parse(data.result);
        // 兼容新数组格式 [{wrong, correct, reason}] 和旧字典格式 {wrong: correct}
        if (Array.isArray(parsed)) {
            AppState.aiSuggestions = parsed.map(item => ({
                wrong: item.wrong || '', correct: item.correct || '', reason: item.reason || ''
            })).filter(s => s.wrong && s.correct);
        } else {
            AppState.aiSuggestions = Object.entries(parsed)
                .filter(([w, c]) => w && c)
                .map(([wrong, correct]) => ({ wrong, correct, reason: '' }));
        }
        AppState.ignoredSuggestions.clear();
        AppState.currentNavIndex = -1;
        renderSuggestionCards();
        renderAIPreview();
    } catch (e) {
        showToast('分析失败: ' + e.message, 'error');
    } finally {
        showLoading(false);
    }
}

function renderAIPreview() {
    if (AppState.subtitles.length === 0) return;
    const box = document.getElementById('previewBox');
    box.innerHTML = '';
    AppState.changeLocations = [];

    // Build dict from non-ignored suggestions
    const dict = {};
    AppState.aiSuggestions.forEach((sugg, i) => {
        if (!AppState.ignoredSuggestions.has(i)) dict[sugg.wrong] = sugg.correct;
    });

    const searchText = document.getElementById('previewTextSearch').value.trim();
    let searchMatchCount = 0;

    AppState.subtitles.forEach((s, idx) => {
        let txt = escapeHtml(s.text);
        let hasChange = false;
        for (const k in dict) {
            const safeKey = escapeRegExp(k);
            const reg = new RegExp(`\\b${safeKey}\\b`, 'gi');
            if (reg.test(s.text)) {
                hasChange = true;
                txt = escapeHtml(s.text).replace(new RegExp(`\\b${safeKey}\\b`, 'gi'),
                    `<span class="change-block"><span class="orig-word">${escapeHtml(k)}</span><span class="arrow">&#10140;</span>${escapeHtml(dict[k])}</span>`
                );
            }
        }
        if (hasChange) AppState.changeLocations.push(idx);

        // 搜索过滤
        let matchesSearch = true;
        if (searchText) {
            if (s.text.toLowerCase().includes(searchText.toLowerCase())) {
                searchMatchCount++;
                const searchReg = new RegExp(`(${escapeRegExp(escapeHtml(searchText))})`, 'gi');
                txt = txt.replace(searchReg, '<mark style="background:#ffeb3b;padding:1px 3px;border-radius:2px">$1</mark>');
            } else {
                matchesSearch = false;
            }
        }

        const div = document.createElement('div');
        div.className = 'sub-card';
        div.id = `card-${idx}`;
        if (hasChange) div.classList.add('has-change');
        if (searchText && !matchesSearch) div.style.display = 'none';
        div.innerHTML = `<div class="meta"><span>#${s.index}</span><span>${s.startTime} --> ${s.endTime}</span></div><div>${txt}</div>`;
        box.appendChild(div);
    });

    // 更新搜索结果提示
    const searchInfo = document.getElementById('previewSearchInfo');
    if (searchText) {
        searchInfo.textContent = `${searchMatchCount} 条匹配`;
    } else {
        searchInfo.textContent = '';
    }

    if (AppState.currentNavIndex >= 0 && AppState.currentNavIndex < AppState.changeLocations.length) {
        const el = document.getElementById(`card-${AppState.changeLocations[AppState.currentNavIndex]}`);
        if (el) el.classList.add('highlight-focus');
    }
    updateCommitState();
}

function previewSearchByNum() {
    const input = document.getElementById('previewNumSearch').value.trim();
    const nums = input.split(/[,，\s]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    if (nums.length === 0) return;
    // 先清除文字过滤，显示所有卡片
    document.getElementById('previewTextSearch').value = '';
    document.querySelectorAll('#previewBox .sub-card').forEach(c => c.style.display = '');
    const results = [];
    AppState.subtitles.forEach((s, idx) => { if (nums.includes(s.index)) results.push(idx); });
    if (results.length === 0) { showToast('未找到该序号', 'error'); return; }
    AppState.previewSearchResults = results;
    AppState.previewSearchResultIndex = 0;
    previewScrollToCard(results[0]);
    updatePreviewSearchNav();
    document.getElementById('previewSearchInfo').textContent = `${results.length} 条匹配`;
}

function previewSearchByTime() {
    const input = document.getElementById('previewTimeSearch').value.trim();
    if (!input) return;
    const match = input.match(/(\d{1,2}):(\d{2}):(\d{2})[,.]?(\d{0,3})/);
    if (!match) { showToast('时间格式无效', 'error'); return; }
    const sec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + (match[4] ? parseInt(match[4].padEnd(3,'0')) / 1000 : 0);
    document.getElementById('previewTextSearch').value = '';
    document.querySelectorAll('#previewBox .sub-card').forEach(c => c.style.display = '');
    let targetIdx = -1;
    AppState.subtitles.forEach((s, idx) => {
        if (sec >= timeToSeconds(s.startTime) && sec <= timeToSeconds(s.endTime)) targetIdx = idx;
    });
    if (targetIdx === -1) {
        let minDiff = Infinity;
        AppState.subtitles.forEach((s, idx) => {
            const d = Math.min(Math.abs(timeToSeconds(s.startTime) - sec), Math.abs(timeToSeconds(s.endTime) - sec));
            if (d < minDiff) { minDiff = d; targetIdx = idx; }
        });
    }
    AppState.previewSearchResults = [targetIdx];
    AppState.previewSearchResultIndex = 0;
    previewScrollToCard(targetIdx);
    updatePreviewSearchNav();
    document.getElementById('previewSearchInfo').textContent = '已定位';
}

function previewSearchByText() {
    AppState.previewSearchResults = [];
    AppState.previewSearchResultIndex = 0;
    document.getElementById('previewSearchNav').style.display = 'none';
    renderAIPreview();
    // 渲染后滚动到第一条匹配
    const searchText = document.getElementById('previewTextSearch').value.trim();
    if (searchText) {
        const first = document.querySelector('#previewBox .sub-card:not([style*="display: none"])');
        if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function previewClearSearch() {
    document.getElementById('previewNumSearch').value = '';
    document.getElementById('previewTimeSearch').value = '';
    document.getElementById('previewTextSearch').value = '';
    document.getElementById('previewSearchInfo').textContent = '';
    document.getElementById('previewSearchNav').style.display = 'none';
    AppState.previewSearchResults = [];
    AppState.previewSearchResultIndex = 0;
    document.querySelectorAll('#previewBox .sub-card').forEach(c => {
        c.style.display = '';
        c.classList.remove('highlight-focus');
    });
}

function previewScrollToCard(arrayIdx) {
    document.querySelectorAll('#previewBox .sub-card').forEach(c => c.classList.remove('highlight-focus'));
    const card = document.getElementById(`card-${arrayIdx}`);
    if (card) {
        card.classList.add('highlight-focus');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function updatePreviewSearchNav() {
    const nav = document.getElementById('previewSearchNav');
    const results = AppState.previewSearchResults;
    if (results.length > 1) {
        nav.style.display = '';
        document.getElementById('previewSearchNavInfo').textContent =
            `${AppState.previewSearchResultIndex + 1} / ${results.length}`;
    } else {
        nav.style.display = 'none';
    }
}

function previewNavPrev() {
    if (AppState.previewSearchResultIndex > 0) {
        AppState.previewSearchResultIndex--;
        previewScrollToCard(AppState.previewSearchResults[AppState.previewSearchResultIndex]);
        updatePreviewSearchNav();
    }
}

function previewNavNext() {
    if (AppState.previewSearchResultIndex < AppState.previewSearchResults.length - 1) {
        AppState.previewSearchResultIndex++;
        previewScrollToCard(AppState.previewSearchResults[AppState.previewSearchResultIndex]);
        updatePreviewSearchNav();
    }
}

function renderSuggestionCards() {
    const container = document.getElementById('suggestionCards');
    if (AppState.aiSuggestions.length === 0) {
        container.innerHTML = '<div class="empty-hint">AI 未发现需要修正的词汇，或等待分析...</div>';
        updateCommitState();
        return;
    }
    container.innerHTML = '';
    AppState.aiSuggestions.forEach((sugg, i) => {
        const ignored = AppState.ignoredSuggestions.has(i);
        const card = document.createElement('div');
        card.className = 'suggestion-card' + (ignored ? ' ignored' : '');
        card.id = `sugg-card-${i}`;
        card.innerHTML = `
            <div class="sugg-main">
                <div class="sugg-correction">
                    <span class="sugg-wrong">${escapeHtml(sugg.wrong)}</span>
                    <span class="sugg-arrow">→</span>
                    <span class="sugg-correct">${escapeHtml(sugg.correct)}</span>
                </div>
                ${sugg.reason ? `<div class="sugg-reason">${escapeHtml(sugg.reason)}</div>` : ''}
            </div>
            <div class="sugg-btns">
                <button class="sugg-edit-btn" onclick="editSuggestion(${i})">编辑</button>
                <button class="sugg-ignore-btn" onclick="toggleSuggIgnore(${i})">${ignored ? '恢复' : '忽略'}</button>
            </div>
        `;
        container.appendChild(card);
    });
    updateCommitState();
}

function toggleSuggIgnore(idx) {
    if (AppState.ignoredSuggestions.has(idx)) AppState.ignoredSuggestions.delete(idx);
    else AppState.ignoredSuggestions.add(idx);
    const card = document.getElementById(`sugg-card-${idx}`);
    if (card) {
        const ignored = AppState.ignoredSuggestions.has(idx);
        card.classList.toggle('ignored', ignored);
        card.querySelector('.sugg-ignore-btn').textContent = ignored ? '恢复' : '忽略';
    }
    renderAIPreview();
    updateCommitState();
}

function editSuggestion(idx) {
    const sugg = AppState.aiSuggestions[idx];
    if (!sugg) return;
    const card = document.getElementById(`sugg-card-${idx}`);
    if (!card) return;
    card.innerHTML = `
        <div class="sugg-main">
            <div class="sugg-correction sugg-editing">
                <input type="text" class="sugg-edit-input sugg-edit-wrong" id="sugg-ew-${idx}" value="${escapeHtml(sugg.wrong)}">
                <span class="sugg-arrow">→</span>
                <input type="text" class="sugg-edit-input sugg-edit-correct" id="sugg-ec-${idx}" value="${escapeHtml(sugg.correct)}">
            </div>
        </div>
        <div class="sugg-btns">
            <button class="sugg-edit-btn sugg-save-btn" onclick="saveSuggestion(${idx})">保存</button>
            <button class="sugg-ignore-btn" onclick="renderSuggestionCards()">取消</button>
        </div>
    `;
    document.getElementById(`sugg-ec-${idx}`).focus();
}

function saveSuggestion(idx) {
    const sugg = AppState.aiSuggestions[idx];
    if (!sugg) return;
    const newWrong = document.getElementById(`sugg-ew-${idx}`).value.trim();
    const newCorrect = document.getElementById(`sugg-ec-${idx}`).value.trim();
    if (!newWrong || !newCorrect) {
        showToast('原文和修正内容不能为空', 'error');
        return;
    }
    sugg.wrong = newWrong;
    sugg.correct = newCorrect;
    renderSuggestionCards();
    renderAIPreview();
}

function updateCommitState() {
    const total = AppState.changeLocations.length;
    const valid = AppState.aiSuggestions.filter((_, i) => !AppState.ignoredSuggestions.has(i)).length;
    const navBar = document.getElementById('navBar');
    if (total > 0) {
        navBar.style.display = '';
        const pos = AppState.currentNavIndex >= 0 ? AppState.currentNavIndex + 1 : 0;
        document.getElementById('changeCounter').textContent = `${pos}/${total} | 有效建议: ${valid}`;
    } else {
        navBar.style.display = 'none';
    }
    const btn = document.getElementById('commitBtn');
    btn.textContent = valid > 0 ? `\u2705 提交 ${valid} 条建议修正` : '无有效建议';
    btn.disabled = valid === 0;
    document.getElementById('oneclickBtn').disabled = false;
}

function scrollNavTarget(target) {
    const box = document.getElementById('previewBox');
    if (!box || !target) return;
    const boxRect = box.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offset = targetRect.top - boxRect.top - (box.clientHeight - target.clientHeight) / 2;
    box.scrollBy({ top: offset, behavior: 'smooth' });
}

function jumpNav(dir) {
    if (AppState.changeLocations.length === 0) return;
    if (AppState.currentNavIndex >= 0 && AppState.currentNavIndex < AppState.changeLocations.length) {
        const old = document.getElementById(`card-${AppState.changeLocations[AppState.currentNavIndex]}`);
        if (old) old.classList.remove('highlight-focus');
    }
    AppState.currentNavIndex += dir;
    if (AppState.currentNavIndex >= AppState.changeLocations.length) AppState.currentNavIndex = 0;
    if (AppState.currentNavIndex < 0) AppState.currentNavIndex = AppState.changeLocations.length - 1;
    const target = document.getElementById(`card-${AppState.changeLocations[AppState.currentNavIndex]}`);
    if (target) {
        scrollNavTarget(target);
        target.classList.add('highlight-focus');
    }
    updateCommitState();
}

function jumpToNavIndex() {
    if (AppState.changeLocations.length === 0) return;
    const input = document.getElementById('diffNavInput');
    const n = parseInt(input.value);
    if (isNaN(n) || n < 1 || n > AppState.changeLocations.length) {
        showToast(`请输入 1 ~ ${AppState.changeLocations.length} 之间的序号`, 'error');
        return;
    }
    if (AppState.currentNavIndex >= 0 && AppState.currentNavIndex < AppState.changeLocations.length) {
        const old = document.getElementById(`card-${AppState.changeLocations[AppState.currentNavIndex]}`);
        if (old) old.classList.remove('highlight-focus');
    }
    AppState.currentNavIndex = n - 1;
    const target = document.getElementById(`card-${AppState.changeLocations[AppState.currentNavIndex]}`);
    if (target) {
        scrollNavTarget(target);
        target.classList.add('highlight-focus');
    }
    updateCommitState();
    input.value = '';
}

function commitCorrections() {
    const active = AppState.aiSuggestions.filter((_, i) => !AppState.ignoredSuggestions.has(i));
    if (active.length === 0) return;
    if (!confirm('确定提交修改？被忽略的建议将保留原样。')) return;
    const dict = {};
    active.forEach(s => { dict[s.wrong] = s.correct; });
    let totalReplacements = 0;
    AppState.subtitles.forEach(s => {
        let txt = s.text;
        for (const k in dict) {
            // 纯 ASCII 用单词边界 \b，CJK 等直接全局替换
            const isAscii = /^[\x00-\x7F]+$/.test(k);
            const reg = isAscii
                ? new RegExp(`\\b${escapeRegExp(k)}\\b`, 'gi')
                : new RegExp(escapeRegExp(k), 'g');
            const before = txt;
            txt = txt.replace(reg, dict[k]);
            if (txt !== before) {
                const matches = before.match(reg);
                totalReplacements += matches ? matches.length : 0;
            }
        }
        s.text = txt;
    });
    AppState.correctionVersion++;
    updateVersionDisplay();
    AppState.aiSuggestions = [];
    AppState.ignoredSuggestions.clear();
    AppState.currentNavIndex = -1;
    renderSuggestionCards();
    renderAIPreview();
    showToast(`已应用 ${active.length} 条建议，共替换 ${totalReplacements} 处，当前版本 v${AppState.correctionVersion}`);
    document.dispatchEvent(new CustomEvent('subtitlesChanged'));
}

async function startFinalTranslation() {
    const content = serializeSRT(AppState.subtitles);

    const progressEl = document.getElementById('loadingProgress');
    showLoading(true, `正在翻译 v${AppState.correctionVersion}...`);
    progressEl.style.display = '';
    progressEl.textContent = '准备中...';

    try {
        const res = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        const { task_id, error } = await res.json();
        if (error) throw new Error(error);

        // 轮询进度，更新 overlay 副文字
        let data;
        while (true) {
            await new Promise(r => setTimeout(r, 1500));
            const sr = await fetch(`/api/translate/status/${task_id}`);
            data = await sr.json();
            progressEl.textContent = data.message || '';
            if (data.status === 'done') break;
            if (data.status === 'error') throw new Error(data.error);
        }

        showTokenStats('tokenStatTrans', data.usage);
        // Parse translation result back into subtitles
        const translated = parseSRT(data.result);
        if (translated.length > 0) {
            // 后端输出格式: 原文(单行)\n译文(单行)，拆分到独立字段
            translated.forEach(sub => {
                const nlIdx = sub.text.indexOf('\n');
                if (nlIdx !== -1) {
                    sub.sourceText = sub.text.substring(0, nlIdx);
                    sub.translationText = sub.text.substring(nlIdx + 1);
                } else {
                    sub.sourceText = sub.text;
                }
            });
            AppState.subtitles = translated;
            reindexSubtitles();
        }
        document.querySelector('.step[data-step="3"]').classList.add('completed');
        showToast('翻译完成，已自动进入导出');
        document.dispatchEvent(new CustomEvent('subtitlesChanged'));
        switchTab(4);
    } catch (e) {
        showToast('翻译失败: ' + e.message, 'error');
    } finally {
        document.getElementById('loadingProgress').style.display = 'none';
        showLoading(false);
    }
}

function showTokenStats(elId, usage) {
    const el = document.getElementById(elId);
    if (!usage) return;
    el.style.display = '';
    const total = usage.total_tokens;
    const display = total >= 10000 ? `${(total / 1000).toFixed(1)}k` : total;
    el.innerHTML = `消耗 Token: <strong>${display}</strong>（输入 ${usage.prompt_tokens} + 输出 ${usage.completion_tokens}）`;
}

// ==================== 一键翻译 ====================

const STAGE_LABELS = {
    preparing: '准备中...',
    analyzing: '阶段 1/4：内容分析',
    translating: '阶段 2/4：并行翻译',
    checking: '阶段 3/4：质量检测',
    fixing: '阶段 4/4：AI 智能修复',
    done: '全部完成',
};

async function startOneclickTranslation() {
    if (AppState.subtitles.length === 0) { showToast('请先上传字幕文件', 'error'); return; }
    const content = serializeSRT(AppState.subtitles);
    const btn = document.getElementById('oneclickBtn');
    const progressPanel = document.getElementById('oneclickProgress');
    const stageText = document.getElementById('oneclickStageText');
    const bar = document.getElementById('oneclickBar');
    const detail = document.getElementById('oneclickDetail');

    btn.disabled = true;
    progressPanel.style.display = '';
    stageText.textContent = '准备中...';
    bar.style.width = '0%';
    detail.textContent = '';

    try {
        const res = await fetch('/api/oneclick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        const { task_id, error } = await res.json();
        if (error) throw new Error(error);

        let data;
        while (true) {
            await new Promise(r => setTimeout(r, 1500));
            const sr = await fetch(`/api/oneclick/status/${task_id}`);
            data = await sr.json();

            const stage = data.stage || 'preparing';
            stageText.textContent = STAGE_LABELS[stage] || stage;
            detail.textContent = data.message || '';

            // 进度条：分析和检测阶段显示脉冲动画，翻译和修复阶段显示实际进度
            if (stage === 'translating' || stage === 'fixing') {
                bar.style.width = (data.progress || 0) + '%';
            } else if (stage === 'analyzing' || stage === 'checking') {
                bar.style.width = '100%';
                bar.style.opacity = '0.6';
            } else if (stage === 'done') {
                bar.style.width = '100%';
                bar.style.opacity = '1';
            }

            if (data.status === 'done') break;
            if (data.status === 'error') throw new Error(data.error);
        }

        bar.style.opacity = '1';
        showTokenStats('tokenStatTrans', data.usage);

        // 解析翻译结果
        const translated = parseSRT(data.result);
        if (translated.length > 0) {
            translated.forEach(sub => {
                const nlIdx = sub.text.indexOf('\n');
                if (nlIdx !== -1) {
                    sub.sourceText = sub.text.substring(0, nlIdx);
                    sub.translationText = sub.text.substring(nlIdx + 1);
                } else {
                    sub.sourceText = sub.text;
                }
            });
            AppState.subtitles = translated;
            reindexSubtitles();
        }

        document.querySelector('.step[data-step="3"]').classList.add('completed');
        document.querySelector('.step[data-step="4"]').classList.add('completed');
        document.dispatchEvent(new CustomEvent('subtitlesChanged'));

        // 构建完成摘要
        let summary = '一键翻译完成';
        if (data.analysis) {
            summary += ` | 领域: ${data.analysis.domain || '未知'}`;
            const gLen = (data.analysis.glossary || []).length;
            if (gLen > 0) summary += ` | 术语: ${gLen}个`;
        }
        if (data.problems_found > 0) {
            summary += ` | 发现${data.problems_found}个问题`;
            summary += `, 已修复${data.fixes_applied}个`;
            if (data.fixes_skipped > 0) {
                summary += `, AI确认无问题${data.fixes_skipped}个`;
            }
        } else {
            summary += ' | 质量检测通过';
        }
        detail.textContent = summary;
        showToast(summary);

        // 一键翻译完成后直接跳转到导出
        document.querySelector('.step[data-step="4"]').classList.add('completed');
        switchTab(4);
    } catch (e) {
        showToast('一键翻译失败: ' + e.message, 'error');
        stageText.textContent = '失败';
        detail.textContent = e.message;
    } finally {
        btn.disabled = false;
    }
}

// ==================== Tab 4: Quality Checks ====================
function runCombinedCheck() {
    if (AppState.subtitles.length === 0) { showToast('请先上传文件', 'error'); return; }

    // 中文字符检测
    const minChars = parseInt(document.getElementById('minChineseChars').value) || 5;
    const ccProblems = [];
    AppState.subtitles.forEach(s => {
        const cnt = countChineseChars(s.text);
        if (cnt < minChars) ccProblems.push({ ...s, chineseCount: cnt });
    });
    AppState.ccProblemIndices = ccProblems.map(p => p.index);

    document.getElementById('ccTotal').textContent = AppState.subtitles.length;
    document.getElementById('ccProblem').textContent = ccProblems.length;
    document.getElementById('ccRate').textContent = AppState.subtitles.length > 0
        ? ((ccProblems.length / AppState.subtitles.length) * 100).toFixed(1) + '%' : '0%';

    const ccList = document.getElementById('ccList');
    if (ccProblems.length === 0) {
        ccList.innerHTML = '<div class="empty-hint" style="padding:20px">未发现问题</div>';
    } else {
        ccList.innerHTML = ccProblems.map(p => `
            <div class="problem-item">
                <div class="p-header"><span class="p-index">#${p.index}</span><span class="p-time">${p.startTime} --> ${p.endTime}</span></div>
                <div class="p-text">${escapeHtml(p.text)}</div>
                <span class="p-badge">中文字数: ${p.chineseCount}</span>
            </div>
        `).join('');
    }

    // 持续时间检测
    const minDur = parseFloat(document.getElementById('minDuration').value) || 0.5;
    const dcProblems = [];
    AppState.subtitles.forEach(s => {
        const dur = timeToSeconds(s.endTime) - timeToSeconds(s.startTime);
        if (dur < minDur) dcProblems.push({ ...s, duration: dur });
    });
    AppState.dcProblemIndices = dcProblems.map(p => p.index);

    document.getElementById('dcTotal').textContent = AppState.subtitles.length;
    document.getElementById('dcProblem').textContent = dcProblems.length;
    document.getElementById('dcRate').textContent = AppState.subtitles.length > 0
        ? ((dcProblems.length / AppState.subtitles.length) * 100).toFixed(1) + '%' : '0%';

    const dcList = document.getElementById('dcList');
    if (dcProblems.length === 0) {
        dcList.innerHTML = '<div class="empty-hint" style="padding:20px">未发现问题</div>';
    } else {
        dcList.innerHTML = dcProblems.map(p => `
            <div class="problem-item">
                <div class="p-header"><span class="p-index">#${p.index}</span><span class="p-time">${p.startTime} --> ${p.endTime}</span></div>
                <div class="p-text">${escapeHtml(p.text)}</div>
                <span class="p-badge">时长: ${p.duration.toFixed(2)}s</span>
            </div>
        `).join('');
    }

    document.getElementById('combinedCheckResult').style.display = '';

    const totalProblems = AppState.ccProblemIndices.length + AppState.dcProblemIndices.length;
    if (totalProblems > 0) {
        document.getElementById('sendToMergeBtnWrapper').style.display = '';
        showToast(`检测完成，共发现 ${totalProblems} 条问题字幕`);
    } else {
        document.getElementById('sendToMergeBtnWrapper').style.display = 'none';
        document.querySelector('.step[data-step="4"]').classList.add('completed');
        showToast('检测通过，无问题字幕，可直接进入导出');
    }
}

function sendAllToMerge() {
    const allIndices = [...new Set([...AppState.ccProblemIndices, ...AppState.dcProblemIndices])].sort((a, b) => a - b);
    document.getElementById('mergeIndicesInput').value = allIndices.join(',');
    document.getElementById('repairSection').scrollIntoView({ behavior: 'smooth' });
    showToast(`已发送 ${allIndices.length} 条序号到下方修复区域`);
}

// ==================== 字幕修复（Tab 4 下半部分） ====================
function startManualMerge() {
    const input = document.getElementById('mergeIndicesInput').value;
    const nums = input.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    if (nums.length === 0) { showToast('请输入有效的字幕编号', 'error'); return; }
    AppState.mergeTargets = nums;
    AppState.mergeCurrentIndex = 0;
    AppState.mergedSubtitles = AppState.subtitles.map(s => ({ ...s }));
    AppState.markedSubtitles = [];
    document.getElementById('manualMergeProgress').style.display = '';
    document.getElementById('manualMergeDisplay').style.display = '';
    document.getElementById('manualMergeComplete').style.display = 'none';
    document.getElementById('viewMarksBtn').style.display = '';
    updateMarkCount();
    showMergeStep();
}

function showMergeStep() {
    if (AppState.mergeCurrentIndex >= AppState.mergeTargets.length) {
        // Done - apply merged subtitles back
        AppState.subtitles = AppState.mergedSubtitles;
        reindexSubtitles();
        document.getElementById('manualMergeDisplay').style.display = 'none';
        document.getElementById('manualMergeProgress').style.display = 'none';
        document.getElementById('manualMergeComplete').style.display = '';
        document.querySelector('.step[data-step="4"]').classList.add('completed');
        document.dispatchEvent(new CustomEvent('subtitlesChanged'));
        return;
    }
    const targetNum = AppState.mergeTargets[AppState.mergeCurrentIndex];
    const targetIdx = AppState.mergedSubtitles.findIndex(s => s.index === targetNum);
    if (targetIdx === -1) {
        showToast(`字幕 #${targetNum} 未找到，已跳过`, 'error');
        AppState.mergeCurrentIndex++;
        showMergeStep();
        return;
    }
    document.getElementById('mergeProgressText').textContent =
        `处理进度：${AppState.mergeCurrentIndex + 1} / ${AppState.mergeTargets.length}`;

    const subs = AppState.mergedSubtitles;
    let html = '';
    if (targetIdx > 0) {
        const prev = subs[targetIdx - 1];
        html += `<div class="merge-context"><div class="p-header"><span class="p-index">&#11014; 上一条 #${prev.index}</span><span class="p-time">&nbsp;&nbsp;${prev.startTime} --> ${prev.endTime}</span></div><div class="p-text">${escapeHtml(prev.text)}</div></div>`;
    }
    const cur = subs[targetIdx];
    html += `<div class="merge-target"><div class="p-header"><span class="p-index">&#127919; 当前字幕 #${cur.index}</span><span class="p-time">&nbsp;&nbsp;${cur.startTime} --> ${cur.endTime}</span></div><div class="p-text">${escapeHtml(cur.text)}</div>`;
    html += '<div class="merge-buttons">';
    if (targetIdx > 0) html += '<button class="btn btn-success btn-sm" onclick="mergeUp()">&#11014; 合并到上一条</button>';
    if (targetIdx < subs.length - 1) html += '<button class="btn btn-info btn-sm" style="background:var(--info);color:white" onclick="mergeDown()">&#11015; 合并到下一条</button>';
    html += '<button class="btn btn-warning btn-sm" onclick="markMerge()">&#128278; 标记</button>';
    html += '<button class="btn btn-secondary btn-sm" onclick="skipMerge()">跳过</button>';
    html += '</div></div>';
    if (targetIdx < subs.length - 1) {
        const next = subs[targetIdx + 1];
        html += `<div class="merge-context"><div class="p-header"><span class="p-index">&#11015; 下一条 #${next.index}</span><span class="p-time">&nbsp;&nbsp;${next.startTime} --> ${next.endTime}</span></div><div class="p-text">${escapeHtml(next.text)}</div></div>`;
    }
    document.getElementById('manualMergeDisplay').innerHTML = html;
}

function mergeUp() {
    const targetNum = AppState.mergeTargets[AppState.mergeCurrentIndex];
    const idx = AppState.mergedSubtitles.findIndex(s => s.index === targetNum);
    if (idx > 0) {
        const cur = AppState.mergedSubtitles[idx];
        const prev = AppState.mergedSubtitles[idx - 1];
        // 合并前保存 prev 的历史状态，并记录被吞并的条目以便还原
        if (!prev._history) prev._history = [];
        prev._history.push({ text: prev.text, startTime: prev.startTime, endTime: prev.endTime, sourceText: prev.sourceText, translationText: prev.translationText, _absorbed: { ...cur } });
        const merged = mergeTextByLanguage(prev, cur);
        prev.text = merged.text;
        prev.sourceText = merged.sourceText;
        prev.translationText = merged.translationText;
        prev.endTime = cur.endTime;
        AppState.mergedSubtitles.splice(idx, 1);
        AppState.modifiedSubtitles.add(prev.index);
        // 同步到主字幕数组
        const mainPrev = AppState.subtitles.find(s => s.index === prev.index);
        if (mainPrev) {
            if (!mainPrev._history) mainPrev._history = [];
            mainPrev._history.push({ text: mainPrev.text, startTime: mainPrev.startTime, endTime: mainPrev.endTime, sourceText: mainPrev.sourceText, translationText: mainPrev.translationText, _absorbed: { ...cur } });
            mainPrev.text = prev.text;
            mainPrev.sourceText = prev.sourceText;
            mainPrev.translationText = prev.translationText;
            mainPrev.startTime = prev.startTime;
            mainPrev.endTime = prev.endTime;
        }
        // 从主字幕数组中也删除被合并的条目
        const mainCurIdx = AppState.subtitles.findIndex(s => s.index === cur.index);
        if (mainCurIdx !== -1) AppState.subtitles.splice(mainCurIdx, 1);
    }
    AppState.mergeCurrentIndex++;
    showMergeStep();
}

function mergeDown() {
    const targetNum = AppState.mergeTargets[AppState.mergeCurrentIndex];
    const idx = AppState.mergedSubtitles.findIndex(s => s.index === targetNum);
    if (idx < AppState.mergedSubtitles.length - 1) {
        const cur = AppState.mergedSubtitles[idx];
        const next = AppState.mergedSubtitles[idx + 1];
        // 合并前保存 next 的历史状态，并记录被吞并的条目以便还原
        if (!next._history) next._history = [];
        next._history.push({ text: next.text, startTime: next.startTime, endTime: next.endTime, sourceText: next.sourceText, translationText: next.translationText, _absorbed: { ...cur } });
        const merged = mergeTextByLanguage(cur, next);
        next.text = merged.text;
        next.sourceText = merged.sourceText;
        next.translationText = merged.translationText;
        next.startTime = cur.startTime;
        AppState.mergedSubtitles.splice(idx, 1);
        AppState.modifiedSubtitles.add(next.index);
        // 同步到主字幕数组
        const mainNext = AppState.subtitles.find(s => s.index === next.index);
        if (mainNext) {
            if (!mainNext._history) mainNext._history = [];
            mainNext._history.push({ text: mainNext.text, startTime: mainNext.startTime, endTime: mainNext.endTime, sourceText: mainNext.sourceText, translationText: mainNext.translationText, _absorbed: { ...cur } });
            mainNext.text = next.text;
            mainNext.sourceText = next.sourceText;
            mainNext.translationText = next.translationText;
            mainNext.startTime = next.startTime;
            mainNext.endTime = next.endTime;
        }
        // 从主字幕数组中也删除被合并的条目
        const mainCurIdx = AppState.subtitles.findIndex(s => s.index === cur.index);
        if (mainCurIdx !== -1) AppState.subtitles.splice(mainCurIdx, 1);
    }
    AppState.mergeCurrentIndex++;
    showMergeStep();
}

function skipMerge() {
    AppState.mergeCurrentIndex++;
    showMergeStep();
}

function markMerge() {
    const targetNum = AppState.mergeTargets[AppState.mergeCurrentIndex];
    const idx = AppState.mergedSubtitles.findIndex(s => s.index === targetNum);
    if (idx !== -1) {
        const cur = AppState.mergedSubtitles[idx];
        const prev = idx > 0 ? { ...AppState.mergedSubtitles[idx - 1] } : null;
        const next = idx < AppState.mergedSubtitles.length - 1 ? { ...AppState.mergedSubtitles[idx + 1] } : null;
        AppState.markedSubtitles.push({ current: { ...cur }, prev, next, timestamp: new Date().toLocaleString() });
        updateMarkCount();
        showToast(`已标记 #${targetNum}`);
    }
}

function updateMarkCount() {
    document.getElementById('markCount').textContent = AppState.markedSubtitles.length;
}

function openMarksModal() {
    const list = document.getElementById('markedList');
    if (AppState.markedSubtitles.length === 0) {
        list.innerHTML = '<div class="empty-hint" style="padding:30px">暂无标记</div>';
    } else {
        list.innerHTML = AppState.markedSubtitles.map((m, i) => `
            <div class="problem-item" style="background:#fff9e6;border-left:5px solid var(--warning)">
                <div class="p-header"><span class="p-index">标记 ${i + 1} - #${m.current.index}</span>
                <button class="btn btn-danger btn-sm" onclick="unmark(${i})">移除</button></div>
                <div style="font-size:0.8em;color:var(--text-muted);margin-bottom:8px">${m.timestamp}</div>
                ${m.prev ? `<div class="merge-context" style="margin-bottom:6px"><div class="p-header"><span class="p-index">&#11014; #${m.prev.index}</span><span class="p-time">&nbsp;&nbsp;${m.prev.startTime} --> ${m.prev.endTime}</span></div><div class="p-text">${escapeHtml(m.prev.text)}</div></div>` : ''}
                <div style="padding:8px;background:#fff3cd;border-radius:4px;margin-bottom:6px;border:2px solid var(--warning)"><div class="p-header"><span class="p-index">&#127919; #${m.current.index}</span><span class="p-time">&nbsp;&nbsp;${m.current.startTime} --> ${m.current.endTime}</span></div><div class="p-text">${escapeHtml(m.current.text)}</div></div>
                ${m.next ? `<div class="merge-context"><div class="p-header"><span class="p-index">&#11015; #${m.next.index}</span><span class="p-time">&nbsp;&nbsp;${m.next.startTime} --> ${m.next.endTime}</span></div><div class="p-text">${escapeHtml(m.next.text)}</div></div>` : ''}
            </div>
        `).join('');
    }
    document.getElementById('marksModal').style.display = 'flex';
}

function closeMarksModal() { document.getElementById('marksModal').style.display = 'none'; }

function unmark(i) {
    if (confirm('确定移除该标记？')) {
        AppState.markedSubtitles.splice(i, 1);
        updateMarkCount();
        openMarksModal();
    }
}

// ==================== 位置调换（Tab 5 上半部分） ====================
function runPositionSwap() {
    if (AppState.subtitles.length === 0) { showToast('请先上传文件', 'error'); return; }
    const direction = document.querySelector('input[name="swapDirection"]:checked').value;
    let swapCount = 0;

    AppState.subtitles.forEach(s => {
        const lines = s.text.split('\n').filter(l => l.trim());
        if (lines.length >= 2) {
            const first = lines[0];
            const second = lines[1];
            let shouldSwap = false;
            if (direction === 'en2cn') {
                shouldSwap = !isChinese(first) && isChinese(second);
            } else {
                shouldSwap = isChinese(first) && !isChinese(second);
            }
            if (shouldSwap) {
                const swapped = [second, first].concat(lines.slice(2));
                s.text = swapped.join('\n');
                swapCount++;
            }
        }
    });

    document.getElementById('swapCount').textContent = swapCount;
    document.getElementById('swapResult').style.display = '';
    document.querySelector('.step[data-step="4"]').classList.add('completed');
    showToast(`已交换 ${swapCount} 条字幕`);
    document.dispatchEvent(new CustomEvent('subtitlesChanged'));
}

// ==================== 下载导出（Tab 5 下半部分） ====================
function refreshDownloadTab() {
    if (AppState.subtitles.length === 0) return;
    document.getElementById('finalCount').textContent = AppState.subtitles.length;
    const last = AppState.subtitles[AppState.subtitles.length - 1];
    document.getElementById('finalDuration').textContent = formatDurationHMS(timeToSeconds(last.endTime));
    const preview = serializeSRT(AppState.subtitles);
    document.getElementById('finalPreview').textContent = preview.slice(0, 5000)
        + (preview.length > 5000 ? '\n\n... (truncated)' : '');
}

function downloadFinalSRT() {
    if (AppState.subtitles.length === 0) { showToast('无数据', 'error'); return; }
    const content = serializeSRT(AppState.subtitles);
    const name = AppState.originalFileName.replace('.srt', '_final.srt');
    downloadBlob(content, name);
    document.querySelector('.step[data-step="4"]').classList.add('completed');
    showToast('已下载！');
}

function downloadBlob(content, filename) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ==================== Floating Editor ====================
function toggleEditor() {
    const panel = document.getElementById('editorPanel');
    if (panel.classList.contains('open')) {
        closeEditor();
    } else {
        openEditor();
    }
}

function openEditor() {
    document.getElementById('editorPanel').classList.add('open');
    document.getElementById('editorBackdrop').classList.add('open');
    document.getElementById('editorToggle').style.display = 'none';
    if (AppState.subtitles.length > 0) editorRender(AppState.subtitles);
}

function closeEditor() {
    document.getElementById('editorPanel').classList.remove('open');
    document.getElementById('editorBackdrop').classList.remove('open');
    // 只在 Tab 5 时恢复显示编辑器按钮
    if (AppState.currentStep === 5) {
        document.getElementById('editorToggle').style.display = '';
    }
}

function editorRender(subs, highlightIds) {
    const container = document.getElementById('editorContent');
    if (subs.length === 0) {
        container.innerHTML = '<div class="empty-hint">暂无字幕</div>';
        return;
    }
    const hl = new Set(highlightIds || []);
    const searchText = document.getElementById('editorTextSearch').value.trim();
    container.innerHTML = subs.map(s => {
        const isMod = AppState.modifiedSubtitles.has(s.index);
        const isHL = hl.has(s.index);
        let displayText = escapeHtml(s.text);
        if (searchText) {
            const reg = new RegExp(`(${escapeRegExp(searchText)})`, 'gi');
            displayText = displayText.replace(reg, '<mark style="background:#ffeb3b;padding:1px 3px;border-radius:2px">$1</mark>');
        }
        return `<div class="ed-item ${isHL ? 'highlight' : ''} ${isMod ? 'modified' : ''}" id="ed-${s.index}">
            <div class="ed-header">
                <span class="ed-num">${s.index}</span>
                <span class="ed-time">${s.startTime} --> ${s.endTime}</span>
                ${isMod ? '<span style="color:var(--success);font-size:0.8em">&#9679;</span>' : ''}
            </div>
            <div class="ed-text">${displayText}</div>
            <div class="ed-actions">
                <button class="btn btn-warning btn-sm" onclick="editorEdit(${s.index})">&#9998; 编辑</button>
                ${isMod ? `<button class="btn btn-secondary btn-sm" onclick="editorRevert(${s.index})">&#8617; 还原</button>` : ''}
            </div>
        </div>`;
    }).join('');

    if (highlightIds && highlightIds.length > 0) {
        setTimeout(() => {
            const el = document.getElementById(`ed-${highlightIds[0]}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
    }
}

function editorSearchByNum() {
    const input = document.getElementById('editorNumSearch').value.trim();
    const nums = input.split(/[,，\s]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    if (nums.length === 0) return;
    const found = nums.filter(n => AppState.subtitles.some(s => s.index === n));
    AppState.editorSearchResults = found;
    AppState.editorResultIndex = 0;
    if (found.length <= 1) {
        editorRender(AppState.subtitles, found);
        document.getElementById('editorNav').style.display = 'none';
    } else {
        editorRenderSingle(found[0]);
        editorUpdateNav();
    }
}

function editorSearchByTime() {
    const input = document.getElementById('editorTimeSearch').value.trim();
    if (!input) return;
    const match = input.match(/(\d{1,2}):(\d{2}):(\d{2})[,.]?(\d{0,3})/);
    if (!match) { showToast('时间格式无效', 'error'); return; }
    const sec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + (match[4] ? parseInt(match[4].padEnd(3, '0')) / 1000 : 0);
    const results = AppState.subtitles.filter(s => sec >= timeToSeconds(s.startTime) && sec <= timeToSeconds(s.endTime));
    if (results.length > 0) {
        const ids = results.map(r => r.index);
        AppState.editorSearchResults = ids;
        AppState.editorResultIndex = 0;
        editorRender(AppState.subtitles, ids);
    } else {
        let closest = AppState.subtitles[0];
        let minDiff = Infinity;
        AppState.subtitles.forEach(s => {
            const d = Math.min(Math.abs(timeToSeconds(s.startTime) - sec), Math.abs(timeToSeconds(s.endTime) - sec));
            if (d < minDiff) { minDiff = d; closest = s; }
        });
        editorRender(AppState.subtitles, [closest.index]);
    }
    document.getElementById('editorNav').style.display = results && results.length > 1 ? '' : 'none';
}

function editorSearchByText() {
    const text = document.getElementById('editorTextSearch').value.trim();
    if (!text) return;
    const results = AppState.subtitles.filter(s => s.text.toLowerCase().includes(text.toLowerCase()));
    const ids = results.map(r => r.index);
    AppState.editorSearchResults = ids;
    AppState.editorResultIndex = 0;
    if (ids.length <= 1) {
        editorRender(results.length > 0 ? results : [], ids);
        document.getElementById('editorNav').style.display = 'none';
    } else {
        editorRenderSingle(ids[0]);
        editorUpdateNav();
    }
}

function editorRenderSingle(idx) {
    const sub = AppState.subtitles.find(s => s.index === idx);
    if (sub) editorRender([sub], [idx]);
}

function editorUpdateNav() {
    const nav = document.getElementById('editorNav');
    if (AppState.editorSearchResults.length > 1) {
        nav.style.display = '';
        document.getElementById('editorNavInfo').textContent =
            `${AppState.editorResultIndex + 1} / ${AppState.editorSearchResults.length}`;
    } else {
        nav.style.display = 'none';
    }
}

function editorPrev() {
    if (AppState.editorResultIndex > 0) {
        AppState.editorResultIndex--;
        editorRenderSingle(AppState.editorSearchResults[AppState.editorResultIndex]);
        editorUpdateNav();
    }
}

function editorNext() {
    if (AppState.editorResultIndex < AppState.editorSearchResults.length - 1) {
        AppState.editorResultIndex++;
        editorRenderSingle(AppState.editorSearchResults[AppState.editorResultIndex]);
        editorUpdateNav();
    }
}

function editorShowAll() {
    AppState.editorSearchResults = [];
    AppState.editorResultIndex = 0;
    document.getElementById('editorNav').style.display = 'none';
    editorRender(AppState.subtitles);
}

function editorClear() {
    document.getElementById('editorNumSearch').value = '';
    document.getElementById('editorTimeSearch').value = '';
    document.getElementById('editorTextSearch').value = '';
    editorShowAll();
}

function editorEdit(idx) {
    const sub = AppState.subtitles.find(s => s.index === idx);
    if (!sub) return;
    const item = document.getElementById(`ed-${idx}`);
    item.innerHTML = `
        <div class="ed-header"><span class="ed-num">#${idx}</span><span class="ed-time">编辑中</span></div>
        <div style="margin-bottom:6px;display:flex;gap:6px;align-items:center">
            <span style="font-size:0.85em;font-weight:600;min-width:50px">开始：</span>
            <input type="text" class="input-sm" id="ed-start-${idx}" value="${sub.startTime}" style="width:140px;font-family:monospace">
        </div>
        <div style="margin-bottom:6px;display:flex;gap:6px;align-items:center">
            <span style="font-size:0.85em;font-weight:600;min-width:50px">结束：</span>
            <input type="text" class="input-sm" id="ed-end-${idx}" value="${sub.endTime}" style="width:140px;font-family:monospace">
        </div>
        <textarea class="textarea" id="ed-text-${idx}" style="height:80px">${sub.text}</textarea>
        <div class="ed-actions">
            <button class="btn btn-success btn-sm" onclick="editorSave(${idx})">&#128190; 保存</button>
            <button class="btn btn-danger btn-sm" onclick="editorCancelEdit()">&#10060; 取消</button>
        </div>
    `;
    item.classList.add('highlight');
    document.getElementById(`ed-text-${idx}`).focus();
}

function editorSave(idx) {
    const sub = AppState.subtitles.find(s => s.index === idx);
    if (!sub) return;
    const newText = document.getElementById(`ed-text-${idx}`).value;
    const newStart = document.getElementById(`ed-start-${idx}`).value;
    const newEnd = document.getElementById(`ed-end-${idx}`).value;
    const timePattern = /^\d{2}:\d{2}:\d{2},\d{3}$/;
    if (!timePattern.test(newStart) || !timePattern.test(newEnd)) {
        showToast('时间格式错误 (HH:MM:SS,mmm)', 'error');
        return;
    }
    // 保存前 push 当前状态到历史栈
    if (!sub._history) sub._history = [];
    sub._history.push({ text: sub.text, startTime: sub.startTime, endTime: sub.endTime, sourceText: sub.sourceText, translationText: sub.translationText });
    sub.text = newText;
    sub.startTime = newStart;
    sub.endTime = newEnd;
    if (newText !== sub.originalText || newStart !== sub.originalStartTime || newEnd !== sub.originalEndTime) {
        AppState.modifiedSubtitles.add(idx);
    } else {
        AppState.modifiedSubtitles.delete(idx);
    }
    // 同步到合并模块（如果合并正在进行中）
    if (AppState.mergedSubtitles.length > 0) {
        const mergeSub = AppState.mergedSubtitles.find(s => s.index === idx);
        if (mergeSub) {
            mergeSub.text = newText;
            mergeSub.startTime = newStart;
            mergeSub.endTime = newEnd;
        }
        // 刷新合并界面显示
        if (AppState.mergeCurrentIndex < AppState.mergeTargets.length) {
            showMergeStep();
        }
    }
    document.getElementById('editorExportBtn').style.display = AppState.modifiedSubtitles.size > 0 ? '' : 'none';
    editorRender(AppState.subtitles);
    document.dispatchEvent(new CustomEvent('subtitlesChanged'));
}

function editorCancelEdit() { editorRender(AppState.subtitles); }

function editorRevert(idx) {
    const sub = AppState.subtitles.find(s => s.index === idx);
    if (!sub) return;
    if (!sub._history || sub._history.length === 0) {
        showToast('没有可还原的历史记录', 'error');
        return;
    }
    if (!confirm('确定还原到上一次状态？')) return;
    const prev = sub._history.pop();
    sub.text = prev.text;
    sub.startTime = prev.startTime;
    sub.endTime = prev.endTime;
    if (prev.sourceText !== undefined) sub.sourceText = prev.sourceText;
    if (prev.translationText !== undefined) sub.translationText = prev.translationText;
    // 如果上一次状态记录了被吞并的条目，恢复它
    if (prev._absorbed) {
        const restored = { ...prev._absorbed };
        // 恢复到主字幕数组（按 index 插入正确位置）
        const insertIdx = AppState.subtitles.findIndex(s => s.index > restored.index);
        if (insertIdx === -1) AppState.subtitles.push(restored);
        else AppState.subtitles.splice(insertIdx, 0, restored);
        // 恢复到合并数组
        if (AppState.mergedSubtitles.length > 0) {
            const mInsertIdx = AppState.mergedSubtitles.findIndex(s => s.index > restored.index);
            if (mInsertIdx === -1) AppState.mergedSubtitles.push(restored);
            else AppState.mergedSubtitles.splice(mInsertIdx, 0, restored);
        }
    }
    // 判断是否还有修改
    if (sub.text === sub.originalText && sub.startTime === sub.originalStartTime && sub.endTime === sub.originalEndTime) {
        AppState.modifiedSubtitles.delete(idx);
    }
    document.getElementById('editorExportBtn').style.display = AppState.modifiedSubtitles.size > 0 ? '' : 'none';
    if (AppState.mergedSubtitles.length > 0) {
        const mergeSub = AppState.mergedSubtitles.find(s => s.index === idx);
        if (mergeSub) {
            mergeSub.text = sub.text;
            mergeSub.startTime = sub.startTime;
            mergeSub.endTime = sub.endTime;
        }
        if (AppState.mergeCurrentIndex < AppState.mergeTargets.length) {
            showMergeStep();
        }
    }
    editorRender(AppState.subtitles);
    document.dispatchEvent(new CustomEvent('subtitlesChanged'));
}

function editorExport() {
    const content = serializeSRT(AppState.subtitles);
    downloadBlob(content, AppState.originalFileName.replace('.srt', '_edited.srt'));
    showToast('已导出！');
}

// ==================== Settings ====================
async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const cfg = await res.json();
        document.getElementById('cfgAnalysisApiKey').value = cfg.analysis_api_key || '';
        document.getElementById('cfgAnalysisBaseUrl').value = cfg.analysis_base_url || '';
        document.getElementById('cfgAnalysisModel').value = cfg.analysis_model || '';
        document.getElementById('cfgTranslationApiKey').value = cfg.translation_api_key || '';
        document.getElementById('cfgTranslationBaseUrl').value = cfg.translation_base_url || '';
        document.getElementById('cfgTranslationModel').value = cfg.translation_model || '';
        document.getElementById('cfgBatchSize').value = cfg.batch_size || 100;
        document.getElementById('cfgParallelBatches').value = cfg.parallel_batches || 3;
        document.getElementById('cfgEnableContentAnalysis').checked = cfg.enable_content_analysis !== false;
        document.getElementById('cfgDefaultPrompt').value = cfg.default_prompt || '';
        AppState.defaultPromptTemplate = cfg.default_prompt || '';
        if (cfg.whisper_model) document.getElementById('transcribeModel').value = cfg.whisper_model;
        if (cfg.whisper_device) document.getElementById('transcribeDevice').value = cfg.whisper_device;
        if (cfg.whisper_language) document.getElementById('transcribeLang').value = cfg.whisper_language;
        if (cfg.whisper_vad_filter !== undefined) document.getElementById('transcribeVadFilter').checked = cfg.whisper_vad_filter;
        if (cfg.whisper_vad_threshold !== undefined) {
            document.getElementById('transcribeVadThreshold').value = cfg.whisper_vad_threshold;
            document.getElementById('vadThresholdVal').textContent = parseFloat(cfg.whisper_vad_threshold).toFixed(2);
        }
        if (cfg.whisper_min_silence_ms) document.getElementById('transcribeMinSilence').value = cfg.whisper_min_silence_ms;
        if (cfg.whisper_word_timestamps !== undefined) document.getElementById('transcribeWordTs').checked = cfg.whisper_word_timestamps;
        if (cfg.whisper_beam_size) {
            document.getElementById('transcribeBeamSize').value = cfg.whisper_beam_size;
            document.getElementById('beamSizeVal').textContent = cfg.whisper_beam_size;
        }
        if (cfg.whisper_prompt) document.getElementById('transcribePrompt').value = cfg.whisper_prompt;
        if (cfg.whisper_engine) {
            document.getElementById('transcribeEngine').value = cfg.whisper_engine;
            if (typeof onEngineChange === 'function') onEngineChange();
        }
        if (cfg.whisper_ff_mdx_kim2 !== undefined) document.getElementById('transcribeFfMdx').checked = cfg.whisper_ff_mdx_kim2;
        
        globalPromptsData = cfg.global_prompts || [];
        renderGlobalPromptsUI();
    } catch (e) {
        console.error('Failed to load config:', e);
    }
}

async function saveSettings() {
    const cfg = {
        analysis_api_key: document.getElementById('cfgAnalysisApiKey').value,
        analysis_base_url: document.getElementById('cfgAnalysisBaseUrl').value,
        analysis_model: document.getElementById('cfgAnalysisModel').value,
        translation_api_key: document.getElementById('cfgTranslationApiKey').value,
        translation_base_url: document.getElementById('cfgTranslationBaseUrl').value,
        translation_model: document.getElementById('cfgTranslationModel').value,
        batch_size: parseInt(document.getElementById('cfgBatchSize').value) || 100,
        parallel_batches: parseInt(document.getElementById('cfgParallelBatches').value) || 3,
        enable_content_analysis: document.getElementById('cfgEnableContentAnalysis').checked,
        default_prompt: document.getElementById('cfgDefaultPrompt').value,
        global_prompts: globalPromptsData.filter(p => (p.content || '').trim() !== '')
    };
    try {
        await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        showToast('设置已保存！');
        AppState.defaultPromptTemplate = cfg.default_prompt || '';
        toggleSettings();
    } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
    }
}

function toggleSettings() {
    const el = document.getElementById('settingsOverlay');
    el.style.display = el.style.display === 'none' ? 'flex' : 'none';
}

// ==================== Keyboard Shortcuts ====================
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && AppState.currentStep === 5) {
        e.preventDefault();
        const panel = document.getElementById('editorPanel');
        if (!panel.classList.contains('open')) toggleEditor();
        document.getElementById('editorTextSearch').focus();
    }
});

// 编辑器搜索框 Enter 键支持
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('editorNumSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); editorSearchByNum(); }
    });
    document.getElementById('editorTimeSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); editorSearchByTime(); }
    });
    document.getElementById('editorTextSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); editorSearchByText(); }
    });
    // 预览搜索框 Enter 键支持
    document.getElementById('previewNumSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); previewSearchByNum(); }
    });
    document.getElementById('previewTimeSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); previewSearchByTime(); }
    });
    document.getElementById('previewTextSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); previewSearchByText(); }
    });

    // 首次访问显示引导
    if (!localStorage.getItem('srt_onboarding_done')) showOnboarding();
});

// ==================== Onboarding Guide ====================
let onboardingStep = 1;
const ONBOARDING_TOTAL = 5;

function showOnboarding() {
    onboardingStep = 1;
    renderOnboarding();
    document.getElementById('onboardingOverlay').classList.add('open');
}

function closeOnboarding() {
    document.getElementById('onboardingOverlay').classList.remove('open');
    localStorage.setItem('srt_onboarding_done', '1');
}

function onboardingNav(dir) {
    onboardingStep = Math.max(1, Math.min(ONBOARDING_TOTAL, onboardingStep + dir));
    renderOnboarding();
}

function renderOnboarding() {
    document.querySelectorAll('.onboarding-step').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.step) === onboardingStep);
    });
    // progress dots
    const prog = document.getElementById('onboardingProgress');
    prog.innerHTML = Array.from({ length: ONBOARDING_TOTAL }, (_, i) =>
        `<div class="onboarding-dot${i + 1 <= onboardingStep ? ' active' : ''}"></div>`
    ).join('');
    // buttons
    document.getElementById('onboardingPrevBtn').style.display = onboardingStep > 1 ? '' : 'none';
    const nextBtn = document.getElementById('onboardingNextBtn');
    if (onboardingStep === ONBOARDING_TOTAL) {
        nextBtn.textContent = '开始使用 ✓';
        nextBtn.onclick = closeOnboarding;
    } else {
        nextBtn.innerHTML = '下一步 &#9654;';
        nextBtn.onclick = () => onboardingNav(1);
    }
}

// ==================== Tab 1: 转录模块 ====================
(function () {
    let _transcribeFile = null;
    let _pollTimer = null;
    let _transcribeResult = null;

    window.setTranscribeFile = function (file) {
        _transcribeFile = file;
        document.getElementById('transcribeFileName').textContent = file.name;
        const mb = (file.size / 1024 / 1024).toFixed(1);
        document.getElementById('transcribeFileSize').textContent = mb + ' MB';
        document.getElementById('transcribePanel').style.display = '';
        document.getElementById('transcribeProgressArea').style.display = 'none';
        document.getElementById('transcribeResultArea').style.display = 'none';
        _transcribeResult = null;
    };

    // 引擎切换时调整 UI 可见性
    window.onEngineChange = function () {
        const engine = document.getElementById('transcribeEngine').value;
        const isCli = engine === 'cli' || (engine === 'auto' && window._cliAvailable);
        // 人声分离仅 CLI 可用
        document.getElementById('voiceSepRow').style.display = isCli ? '' : 'none';
        // 单字时间戳仅 Python 模式有意义
        document.getElementById('wordTsRow').style.display = isCli ? 'none' : '';
    };

    // 检测 CLI 可用性（启动时及安装后刷新）
    async function checkTranscribeCapabilities() {
        try {
            const res = await fetch('/api/transcribe/capabilities');
            const caps = await res.json();
            window._cliAvailable = caps.cli_available;
            const statusEl = document.getElementById('engineStatus');
            const installCard = document.getElementById('cliInstallCard');
            if (caps.cli_available) {
                statusEl.textContent = '✓ CLI 可用';
                statusEl.style.color = 'var(--success, green)';
                if (installCard) installCard.style.display = 'none';
            } else {
                statusEl.textContent = '✗ CLI 未找到，将使用 Python 库';
                statusEl.style.color = 'var(--danger, #e74c3c)';
                if (installCard) {
                    installCard.style.display = 'block';
                    const pathEl = document.getElementById('cliToolsPath');
                    if (pathEl && caps.tools_dir) pathEl.textContent = caps.tools_dir + '\\faster-whisper-xxl.exe';
                }
            }
            onEngineChange();
        } catch (e) { /* ignore */ }
    }
    checkTranscribeCapabilities();

    window.openToolsDir = async function () {
        await fetch('/api/open-tools-dir', { method: 'POST' });
    };

    window.saveWhisperConfig = async function () {
        await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                whisper_engine: document.getElementById('transcribeEngine').value,
                whisper_model: document.getElementById('transcribeModel').value,
                whisper_device: document.getElementById('transcribeDevice').value,
                whisper_language: document.getElementById('transcribeLang').value,
                whisper_vad_filter: document.getElementById('transcribeVadFilter').checked,
                whisper_vad_threshold: parseFloat(document.getElementById('transcribeVadThreshold').value),
                whisper_min_silence_ms: parseInt(document.getElementById('transcribeMinSilence').value),
                whisper_word_timestamps: document.getElementById('transcribeWordTs').checked,
                whisper_beam_size: parseInt(document.getElementById('transcribeBeamSize').value),
                whisper_ff_mdx_kim2: document.getElementById('transcribeFfMdx').checked,
                whisper_prompt: document.getElementById('transcribePrompt').value,
            })
        });
    };

    window.startTranscription = async function () {
        if (!_transcribeFile) return;

        // 弹出确认语言对话框
        const langSelect = document.getElementById('transcribeLang');
        const currentLang = langSelect.value;
        const langText = currentLang && currentLang !== 'auto'
            ? langSelect.options[langSelect.selectedIndex].text
            : null;

        const confirmed = await new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000';
            const box = document.createElement('div');
            box.style.cssText = 'background:var(--bg-card,#fff);border-radius:12px;padding:24px 32px;min-width:320px;box-shadow:0 8px 32px rgba(0,0,0,0.3)';
            box.innerHTML = `
                <h3 style="margin:0 0 16px;text-align:center">请确认源语言</h3>
                <select id="confirmLangSelect" class="input-sm" style="width:100%;padding:8px;font-size:15px;margin-bottom:20px">
                    ${Array.from(langSelect.options).filter(o => o.value && o.value !== 'auto').map(o =>
                        `<option value="${o.value}"${o.value === currentLang ? ' selected' : ''}>${o.text}</option>`
                    ).join('')}
                </select>
                <div style="display:flex;gap:12px;justify-content:center">
                    <button id="confirmLangOk" class="btn btn-primary" style="min-width:80px">开始转录</button>
                    <button id="confirmLangCancel" class="btn btn-secondary" style="min-width:80px">取消</button>
                </div>`;
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            box.querySelector('#confirmLangOk').onclick = () => {
                const picked = box.querySelector('#confirmLangSelect').value;
                langSelect.value = picked;
                saveWhisperConfig();
                document.body.removeChild(overlay);
                resolve(true);
            };
            box.querySelector('#confirmLangCancel').onclick = () => {
                document.body.removeChild(overlay);
                resolve(false);
            };
        });
        if (!confirmed) return;

        if (_pollTimer) clearInterval(_pollTimer);
        _transcribeResult = null;

        document.getElementById('transcribeStartBtn').disabled = true;
        document.getElementById('transcribeProgressArea').style.display = '';
        document.getElementById('transcribeResultArea').style.display = 'none';
        setTranscribeProgress(0, '上传文件中...');

        const formData = new FormData();
        formData.append('file', _transcribeFile);
        formData.append('model', document.getElementById('transcribeModel').value);
        formData.append('device', document.getElementById('transcribeDevice').value);
        formData.append('language', document.getElementById('transcribeLang').value);
        formData.append('vad_filter', document.getElementById('transcribeVadFilter').checked);
        formData.append('vad_threshold', document.getElementById('transcribeVadThreshold').value);
        formData.append('min_silence_ms', document.getElementById('transcribeMinSilence').value);
        formData.append('word_timestamps', document.getElementById('transcribeWordTs').checked);
        formData.append('beam_size', document.getElementById('transcribeBeamSize').value);
        formData.append('initial_prompt', document.getElementById('transcribePrompt').value);
        formData.append('engine', document.getElementById('transcribeEngine').value);
        formData.append('ff_mdx_kim2', document.getElementById('transcribeFfMdx').checked);

        let taskId;
        try {
            const res = await fetch('/api/transcribe/start', { method: 'POST', body: formData });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            taskId = data.task_id;
        } catch (e) {
            showToast('转录启动失败: ' + e.message, 'error');
            document.getElementById('transcribeStartBtn').disabled = false;
            return;
        }

        _pollTimer = setInterval(async () => {
            try {
                const res = await fetch(`/api/transcribe/status/${taskId}`);
                const task = await res.json();
                if (task.status === 'loading' || task.status === 'pending') {
                    setTranscribeProgress(8, task.message || '加载模型...');
                } else if (task.status === 'transcribing') {
                    // 将后端 0-99% 映射到 12-99%，避免从 loading 阶段的 8% 倒退
                    const pct = 12 + Math.round((task.progress || 0) * 0.87);
                    setTranscribeProgress(pct, task.message || '转录中...');
                } else if (task.status === 'done') {
                    clearInterval(_pollTimer);
                    _pollTimer = null;
                    _transcribeResult = task.result;
                    setTranscribeProgress(100, task.message);
                    showTranscribeResult(task.result);
                    document.getElementById('transcribeStartBtn').disabled = false;
                } else if (task.status === 'error') {
                    clearInterval(_pollTimer);
                    _pollTimer = null;
                    setTranscribeProgress(0, '');
                    document.getElementById('transcribeProgressArea').style.display = 'none';
                    showToast('转录失败: ' + task.error, 'error');
                    document.getElementById('transcribeStartBtn').disabled = false;
                }
            } catch (e) { /* network blip, keep polling */ }
        }, 1500);
    };

    function setTranscribeProgress(pct, msg) {
        document.getElementById('transcribeProgressBar').style.width = pct + '%';
        document.getElementById('transcribeProgressMsg').textContent = msg;
    }

    function showTranscribeResult(srtText) {
        const subs = parseSRT(srtText);
        document.getElementById('transcribeSubCount').textContent = subs.length;
        if (subs.length > 0) {
            const last = subs[subs.length - 1];
            document.getElementById('transcribeResultDuration').textContent = formatDurationHMS(timeToSeconds(last.endTime));
        }
        document.getElementById('transcribeResultArea').style.display = '';
    }

    window.loadTranscribeResult = function () {
        if (!_transcribeResult) return;
        const subs = parseSRT(_transcribeResult);
        if (subs.length === 0) { showToast('SRT 解析失败', 'error'); return; }
        AppState.subtitles = subs;
        AppState.originalFileName = (_transcribeFile ? _transcribeFile.name.replace(/\.[^.]+$/, '') : 'transcribed') + '.srt';
        AppState.correctionVersion = 0;
        AppState.aiSuggestions = [];
        AppState.ignoredSuggestions.clear();
        AppState.modifiedSubtitles.clear();
        reindexSubtitles();
        // Auto-detect language and set merge defaults (also triggers previewMerge)
        AppState.subtitleLang = detectSubtitleLanguage(AppState.subtitles);
        setMergeDefaults(AppState.subtitleLang);
        document.getElementById('statTotal').textContent = subs.length;
        const last = subs[subs.length - 1];
        document.getElementById('statDuration').textContent = formatDurationHMS(timeToSeconds(last.endTime));
        document.getElementById('statFileName').textContent = AppState.originalFileName;
        document.getElementById('uploadStats').style.display = '';
        document.getElementById('oneclickBtn').disabled = false;
        document.querySelector('.step[data-step="1"]').classList.add('completed');
        document.dispatchEvent(new CustomEvent('subtitlesChanged'));
        switchTab(2);
        showToast(`已加载 ${subs.length} 条字幕，可继续下一步`);
    };

    window.downloadTranscribeSRT = function () {
        if (!_transcribeResult) return;
        const name = (_transcribeFile ? _transcribeFile.name.replace(/\.[^.]+$/, '') : 'transcribed') + '.srt';
        const blob = new Blob([_transcribeResult], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
    };
})();

// ==================== 服务器日志面板 ====================
(function () {
    let _logOpen = false;
    let _logTimer = null;
    let _logTotal = 0;

    const LEVEL_COLORS = {
        'ERROR':   '#f87171',
        'WARNING': '#fbbf24',
        'WARN':    '#fbbf24',
        'INFO':    '#86efac',
        'DEBUG':   '#94a3b8',
    };

    function colorize(line) {
        const match = line.match(/\[(\w+)\]/);
        const color = match ? (LEVEL_COLORS[match[1]] || '#c7d2fe') : '#c7d2fe';
        const escaped = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<span style="color:${color}">${escaped}</span>`;
    }

    async function fetchLogs() {
        try {
            const res = await fetch(`/api/logs?offset=${_logTotal}`);
            if (!res.ok) return;
            const data = await res.json();
            if (data.lines && data.lines.length > 0) {
                const el = document.getElementById('logContent');
                data.lines.forEach(line => {
                    el.insertAdjacentHTML('beforeend', colorize(line) + '<br>');
                });
                // 裁剪 DOM，保留最后 500 条（每条 = span + br = 2个节点）
                while (el.childNodes.length > 1000) {
                    el.removeChild(el.firstChild);
                    if (el.firstChild && el.firstChild.nodeName === 'BR') {
                        el.removeChild(el.firstChild);
                    }
                }
                _logTotal = data.total;
                if (document.getElementById('logAutoScroll').checked) {
                    el.scrollTop = el.scrollHeight;
                }
            }
        } catch (e) { /* 忽略网络错误 */ }
    }

    window.toggleLogPanel = function () {
        const panel = document.getElementById('logPanel');
        const btn = document.getElementById('logBtn');
        _logOpen = !_logOpen;
        panel.style.display = _logOpen ? 'flex' : 'none';
        btn.style.background = _logOpen ? 'rgba(99,102,241,0.25)' : '';
        if (_logOpen) {
            fetchLogs();
            _logTimer = setInterval(fetchLogs, 3000);
        } else {
            clearInterval(_logTimer);
        }
    };

    window.clearLogDisplay = function () {
        document.getElementById('logContent').innerHTML = '';
        _logTotal = 0;
    };
})();


