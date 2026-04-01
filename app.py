"""
SRT 字幕翻译工作台 - 统一版
Flask 后端：提供 AI 分析/翻译 API 代理 + 配置管理
"""

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
from flask import Flask, jsonify, render_template, request

# ==================== 日志 ====================

_LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
os.makedirs(_LOG_DIR, exist_ok=True)
_LOG_FILE = os.path.join(_LOG_DIR, 'app.log')

# 内存日志缓冲：保留最近 500 条
_log_buffer: list = []
_log_buffer_lock = threading.Lock()

class _MemoryHandler(logging.Handler):
    def emit(self, record):
        msg = self.format(record)
        with _log_buffer_lock:
            _log_buffer.append(msg)
            if len(_log_buffer) > 500:
                del _log_buffer[0]

_mem_handler = _MemoryHandler()
_mem_handler.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S'))

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    handlers=[
        logging.FileHandler(_LOG_FILE, encoding='utf-8'),
        logging.StreamHandler(),
        _mem_handler,
    ]
)
logger = logging.getLogger(__name__)

# ==================== 配置 ====================

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')

DEFAULT_CONFIG = {
    "analysis_api_key": "",
    "analysis_base_url": "",
    "analysis_model": "",
    "translation_api_key": "",
    "translation_base_url": "",
    "translation_model": "",
    "batch_size": 100,
    "parallel_batches": 3,
    "enable_content_analysis": True,
    "whisper_model": "large-v2",
    "whisper_device": "cuda",
    "whisper_cli_exe": "",
    "whisper_cli_model_dir": "",
    "default_prompt": """这是某个视频的语音转文字字幕，可能存在口音导致的识别错误，请找出误识别的词语。
常见错误：Claude 被识别成 Cloud，LLM 被识别成 LM 或 LOLM，DeepSeek 被识别成 deep sea，Gemini 被识别成 gem，ChatGPT/Claude/Anthropic/DeepSeek/Gemini 经常识别错误。
视频内容是：【复制粘贴视频的标题和简介】"""
}


def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            saved = json.load(f)
        merged = {**DEFAULT_CONFIG, **saved}
        return merged
    return dict(DEFAULT_CONFIG)


def save_config(cfg: dict):
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


# ==================== LLM 服务 ====================

@dataclass
class SubtitleEntry:
    index: int
    timecode: str
    text: str


class StringUtils:
    @staticmethod
    def normalize(text: str) -> str:
        return re.sub(r'[^a-zA-Z0-9]', '', text).lower()


class LLMService:
    def __init__(self, cfg: dict):
        self.analysis_api_key = cfg['analysis_api_key']
        self.analysis_base_url = cfg['analysis_base_url'].rstrip('/')
        self.translation_api_key = cfg['translation_api_key']
        self.translation_base_url = cfg['translation_base_url'].rstrip('/')

    def _call_chat_completions(self, messages, model, temperature=0.1, base_url=None, api_key=None):
        url = f'{base_url}/chat/completions'
        headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }
        payload = {
            'model': model,
            'messages': messages,
            'temperature': temperature
        }
        response = requests.post(url, headers=headers, json=payload, timeout=180)
        response.raise_for_status()
        data = response.json()
        content = data['choices'][0]['message']['content']
        usage = data.get('usage', {
            'prompt_tokens': 0,
            'completion_tokens': 0,
            'total_tokens': 0
        })
        return content, usage

    def analyze_corrections(self, text_sample: str, user_prompt: str, model: str) -> Tuple[str, Dict]:
        system_prompt = "You are a helpful assistant that outputs only valid JSON."
        full_prompt = f"""{user_prompt}

【待分析文本】
{text_sample}

【输出要求】
1. 只输出一个标准的 JSON 数组（不要输出对象/字典）。
2. 每个元素格式：{{ "wrong": "错误文本", "correct": "正确文本", "reason": "一句话说明为何判断是误识别" }}
3. 如果没有发现错误，输出空数组 []。
4. 不要包含任何 Markdown 标记，直接输出裸 JSON。
"""
        messages = [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': full_prompt}
        ]
        content, usage = self._call_chat_completions(messages, model,
            base_url=self.analysis_base_url, api_key=self.analysis_api_key)
        cleaned = content.strip()
        if cleaned.startswith('```json'):
            cleaned = cleaned[7:]
        if cleaned.startswith('```'):
            cleaned = cleaned[3:]
        if cleaned.endswith('```'):
            cleaned = cleaned[:-3]
        return cleaned.strip(), usage

    def analyze_content(self, sample_text: str, model: str) -> Tuple[str, Dict]:
        """翻译前内容分析：识别领域、提取术语表、风格建议"""
        prompt = f"""你是一个专业的字幕翻译顾问。请分析以下字幕文本样本，为后续翻译提供指导。

【字幕样本】
{sample_text}

【请输出以下 JSON 格式】
{{
  "domain": "该内容所属领域（如：科技、金融、医学、日常对话、游戏等）",
  "style": "语体风格建议（如：口语化、正式、技术性等）",
  "glossary": [
    {{"en": "英文术语", "zh": "建议中文翻译"}},
    ...
  ],
  "notes": "其他翻译注意事项（简短）"
}}

要求：
1. glossary 只收录专有名词、技术术语、人名品牌等需要统一翻译的词，不要收录常见词汇
2. 如果没有特殊术语，glossary 为空数组
3. 只输出 JSON，不要输出其他内容"""
        messages = [{'role': 'user', 'content': prompt}]
        content, usage = self._call_chat_completions(messages, model,
            base_url=self.translation_base_url, api_key=self.translation_api_key)
        cleaned = content.strip()
        if cleaned.startswith('```json'):
            cleaned = cleaned[7:]
        if cleaned.startswith('```'):
            cleaned = cleaned[3:]
        if cleaned.endswith('```'):
            cleaned = cleaned[:-3]
        return cleaned.strip(), usage

    def diagnose_and_fix(self, problem_items: list, model: str) -> Tuple[str, Dict]:
        """AI 诊断问题字幕并给出修复方案"""
        blocks = []
        for item in problem_items:
            block = f"问题字幕 #{item['index']}（{item['reason']}）：\n"
            if item.get('prev'):
                p = item['prev']
                block += f"  上一条 #{p['index']} | {p['timecode']} | 原文: {p['source']} | 译文: {p['translation']}\n"
            c = item['current']
            block += f"  当前   #{c['index']} | {c['timecode']} | 原文: {c['source']} | 译文: {c['translation']}\n"
            if item.get('next'):
                n = item['next']
                block += f"  下一条 #{n['index']} | {n['timecode']} | 原文: {n['source']} | 译文: {n['translation']}\n"
            blocks.append(block)

        prompt = f"""你是一个专业的字幕翻译质量检测员。以下是一些存在问题的字幕条目（附上下文）。
请逐条判断该如何处理，只给出合并方向，不要自行生成任何译文内容。

{chr(10).join(blocks)}

【请输出 JSON 数组，每个元素格式】
{{
  "index": 序号,
  "action": "merge_up" 或 "merge_down" 或 "skip",
  "reason": "简短说明原因"
}}

判断标准：
- 如果当前条目与上一条语义连贯（是上一句的延续），选 merge_up
- 如果当前条目与下一条语义连贯（是下一句的铺垫），选 merge_down
- 如果语义上独立或无法判断，选 skip
- 不要输出任何译文，合并后的翻译由系统自动处理

只输出 JSON 数组，不要输出其他内容。"""
        messages = [{'role': 'user', 'content': prompt}]
        content, usage = self._call_chat_completions(messages, model,
            base_url=self.translation_base_url, api_key=self.translation_api_key)
        cleaned = content.strip()
        if cleaned.startswith('```json'):
            cleaned = cleaned[7:]
        if cleaned.startswith('```'):
            cleaned = cleaned[3:]
        if cleaned.endswith('```'):
            cleaned = cleaned[:-3]
        return cleaned.strip(), usage

    def translate_batch(self, batch: List[SubtitleEntry], model: str, glossary_hint: str = "") -> Tuple[str, Dict]:
        input_block = "\n".join(
            [f"{e.index} | {e.text.replace(chr(10), ' ')}" for e in batch]
        )
        glossary_section = ""
        if glossary_hint:
            glossary_section = f"\n【术语表（请严格遵循以下翻译）】\n{glossary_hint}\n"
        prompt = f"""你是一个精通SRT字幕翻译的AI。
请将提供的字幕列表翻译成中文，保持原文的语气和表达风格，确保翻译准确且符合语境，翻译结果的末尾不能带有标点符号。
{glossary_section}
【输入格式】
序号 | 原文

【输出强制要求】
1. 必须严格按照以下格式逐行输出：
序号 | 原文 | 中文译文
2. 序号必须与输入的序号一一对应，不能改变。
3. "原文"必须是你收到的原文，用于校验位置，不要修改它。
4. 输入有多少行，输出就必须有多少行，不能合并、跳过或省略任何一行。
5. 即使某行是半截句子（句子在下一行继续），也必须单独翻译这半截并输出这一行。
6. 绝对不要输出其他解释性文字。

【待翻译内容】
{input_block}
"""
        messages = [{'role': 'user', 'content': prompt}]
        return self._call_chat_completions(messages, model,
            base_url=self.translation_base_url, api_key=self.translation_api_key)


# ==================== SRT 后端处理 ====================

class SRTBackend:
    @staticmethod
    def parse_from_string(content: str) -> List[SubtitleEntry]:
        entries = []
        content = content.replace('\r\n', '\n').replace('\r', '\n')
        blocks = re.split(r'\n\s*\n', content.strip())
        for block in blocks:
            lines = [l.strip() for l in block.strip().split('\n') if l.strip()]
            if len(lines) < 3:
                continue
            try:
                index = int(re.sub(r'[^\d]', '', lines[0]))
                if '-->' not in lines[1]:
                    continue
                entries.append(SubtitleEntry(index, lines[1], '\n'.join(lines[2:])))
            except (ValueError, IndexError):
                continue
        return entries

    @staticmethod
    def run_analysis(srt_content: str, prompt: str, cfg: dict) -> Dict:
        entries = SRTBackend.parse_from_string(srt_content)
        full_text = "\n".join([e.text for e in entries])
        llm = LLMService(cfg)
        result_json, usage = llm.analyze_corrections(full_text, prompt, cfg['analysis_model'])
        return {'result': result_json, 'usage': usage}

    @staticmethod
    def run_content_analysis(entries: List[SubtitleEntry], cfg: dict) -> Optional[dict]:
        """翻译前内容分析：取样 → AI 生成术语表+领域识别"""
        sample_size = min(200, len(entries))
        sample_text = "\n".join([e.text for e in entries[:sample_size]])
        llm = LLMService(cfg)
        try:
            raw, usage = llm.analyze_content(sample_text, cfg['translation_model'])
            analysis = json.loads(raw)
            logger.info("内容分析完成: 领域=%s, 术语数=%d",
                        analysis.get('domain', '未知'),
                        len(analysis.get('glossary', [])))
            return {'analysis': analysis, 'usage': usage}
        except Exception as e:
            logger.warning("内容分析失败（不影响翻译）: %s", e)
            return None

    @staticmethod
    def _build_glossary_hint(analysis: Optional[dict]) -> str:
        """从分析结果构建术语表提示文本"""
        if not analysis:
            return ""
        glossary = analysis.get('analysis', {}).get('glossary', [])
        if not glossary:
            return ""
        lines = [f"- {item['en']} → {item['zh']}" for item in glossary
                 if item.get('en') and item.get('zh')]
        return "\n".join(lines) if lines else ""

    @staticmethod
    def run_translation(srt_content: str, cfg: dict, progress_cb=None,
                        glossary_hint: str = "") -> Dict:
        entries = SRTBackend.parse_from_string(srt_content)
        llm = LLMService(cfg)
        batch_size = cfg.get('batch_size', 100)
        parallel = cfg.get('parallel_batches', 3)
        total_usage = {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}
        _usage_lock = threading.Lock()

        # 切分批次
        batches = []
        for i in range(0, len(entries), batch_size):
            batches.append(entries[i:i + batch_size])
        total_batches = len(batches)
        completed_count = [0]  # 用 list 以便在闭包中修改

        def _translate_one_batch(batch_idx: int, batch: List[SubtitleEntry]):
            """翻译单个批次，含行数校验和重试"""
            batch_num = batch_idx + 1
            for attempt in range(3):
                try:
                    raw_resp, usage = llm.translate_batch(
                        batch, cfg['translation_model'], glossary_hint=glossary_hint)
                    with _usage_lock:
                        total_usage['prompt_tokens'] += usage.get('prompt_tokens', 0)
                        total_usage['completion_tokens'] += usage.get('completion_tokens', 0)
                        total_usage['total_tokens'] += usage.get('total_tokens', 0)
                    aligned = SRTBackend._align(raw_resp.strip(), batch)
                    # 行数校验：返回的译文数量必须等于输入行数
                    empty_count = sum(1 for t in aligned if not t.strip())
                    if empty_count > len(batch) * 0.2:
                        logger.warning("第 %d 批行数校验失败: %d/%d 条译文为空，重试中...",
                                       batch_num, empty_count, len(batch))
                        if attempt < 2:
                            time.sleep(1)
                            continue
                    logger.info("第 %d/%d 批翻译完成", batch_num, total_batches)
                    return batch_idx, aligned
                except Exception as e:
                    logger.warning("第 %d 批翻译失败 (第 %d 次): %s", batch_num, attempt + 1, e)
                    time.sleep(1)
            raise Exception(f"第 {batch_num} 批翻译失败，已重试 3 次。请检查网络连接和 API 配置。")

        # 并行翻译
        results = [None] * total_batches
        if progress_cb:
            progress_cb(0, total_batches)

        with ThreadPoolExecutor(max_workers=parallel) as executor:
            futures = {
                executor.submit(_translate_one_batch, idx, batch): idx
                for idx, batch in enumerate(batches)
            }
            for future in as_completed(futures):
                batch_idx, aligned = future.result()  # 异常会在这里抛出
                results[batch_idx] = aligned
                completed_count[0] += 1
                if progress_cb:
                    progress_cb(completed_count[0], total_batches)

        # 按原顺序拼接
        final_trans = []
        for r in results:
            final_trans.extend(r)

        output = []
        for i, entry in enumerate(entries):
            output.append(f"{entry.index}\n{entry.timecode}\n{entry.text}\n{final_trans[i]}\n")
        return {'result': "\n".join(output), 'usage': total_usage}

    @staticmethod
    def run_dedup_fix(entries: List[SubtitleEntry], min_overlap: int = 8) -> int:
        """检测并修复相邻条目间的重复译文前缀（N+1 条译文以 N 条译文开头）"""
        sorted_entries = sorted(entries, key=lambda e: e.index)
        fixed = 0
        for i in range(len(sorted_entries) - 1):
            entry_n = sorted_entries[i]
            entry_n1 = sorted_entries[i + 1]
            lines_n = entry_n.text.split('\n')
            lines_n1 = entry_n1.text.split('\n')
            if len(lines_n) < 2 or len(lines_n1) < 2:
                continue
            trans_n = lines_n[1].strip()
            trans_n1 = lines_n1[1].strip()
            if len(trans_n) >= min_overlap and trans_n1.startswith(trans_n):
                new_trans = trans_n1[len(trans_n):].strip()
                if new_trans:
                    old_text = entry_n1.text
                    entry_n1.text = lines_n1[0] + '\n' + new_trans
                    logger.info("[去重] #%s 去除重复前缀（来自 #%s）", entry_n1.index, entry_n.index)
                    logger.info("  修改前: %s", old_text.replace('\n', ' | '))
                    logger.info("  修改后: %s", entry_n1.text.replace('\n', ' | '))
                    fixed += 1
        return fixed

    @staticmethod
    def run_quality_check(entries: List[SubtitleEntry], min_chars: int = 5,
                          min_duration: float = 0.5) -> List[dict]:
        """后端质量检测：返回问题条目列表"""
        def _time_to_seconds(t: str) -> float:
            t = t.replace(',', '.').strip()
            parts = t.split(':')
            if len(parts) == 3:
                return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
            return 0.0

        problems = []
        for sub in entries:
            # 中文字数检测
            cn_count = sum(1 for c in sub.text if '\u4e00' <= c <= '\u9fff')
            times = sub.timecode.split('-->')
            dur = 0.0
            if len(times) == 2:
                dur = _time_to_seconds(times[1]) - _time_to_seconds(times[0])

            reasons = []
            if cn_count < min_chars:
                reasons.append(f"中文字数不足({cn_count}<{min_chars})")
            if dur < min_duration:
                reasons.append(f"持续时间过短({dur:.2f}s<{min_duration}s)")
            if reasons:
                problems.append({
                    'index': sub.index,
                    'timecode': sub.timecode,
                    'text': sub.text,
                    'reasons': reasons,
                })
        return problems

    @staticmethod
    def run_ai_fix(entries: List[SubtitleEntry], problems: List[dict],
                   cfg: dict, progress_cb=None) -> Dict:
        """AI 智能修复：诊断问题条目并自动修复"""
        if not problems:
            return {'fixes': [], 'usage': {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}, 'applied': 0}

        # 构建索引映射
        entry_map = {e.index: e for e in entries}

        # 构建问题条目 + 上下文
        sorted_entries = sorted(entries, key=lambda e: e.index)
        idx_to_pos = {e.index: i for i, e in enumerate(sorted_entries)}

        problem_items = []
        for p in problems:
            idx = p['index']
            pos = idx_to_pos.get(idx)
            if pos is None:
                continue
            item = {
                'index': idx,
                'reason': '；'.join(p['reasons']),
                'current': {
                    'index': idx,
                    'timecode': p['timecode'],
                    'source': '',
                    'translation': p['text'],
                }
            }
            # 解析双语字幕文本（原文\n译文 格式）
            text_lines = p['text'].split('\n')
            if len(text_lines) >= 2:
                item['current']['source'] = text_lines[0]
                item['current']['translation'] = text_lines[1]
            else:
                item['current']['source'] = p['text']
                item['current']['translation'] = p['text']

            # 上一条
            if pos > 0:
                prev_e = sorted_entries[pos - 1]
                prev_lines = prev_e.text.split('\n')
                item['prev'] = {
                    'index': prev_e.index,
                    'timecode': prev_e.timecode,
                    'source': prev_lines[0] if prev_lines else prev_e.text,
                    'translation': prev_lines[1] if len(prev_lines) >= 2 else '',
                }
            # 下一条
            if pos < len(sorted_entries) - 1:
                next_e = sorted_entries[pos + 1]
                next_lines = next_e.text.split('\n')
                item['next'] = {
                    'index': next_e.index,
                    'timecode': next_e.timecode,
                    'source': next_lines[0] if next_lines else next_e.text,
                    'translation': next_lines[1] if len(next_lines) >= 2 else '',
                }
            problem_items.append(item)

        if not problem_items:
            return {'fixes': [], 'usage': {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}, 'applied': 0}

        # 分批发送（每批最多 30 个问题条目，避免 prompt 过长）
        llm = LLMService(cfg)
        all_fixes = []
        total_usage = {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}
        batch_size = 30
        fix_batches = [problem_items[i:i + batch_size] for i in range(0, len(problem_items), batch_size)]

        for bi, fb in enumerate(fix_batches):
            try:
                raw, usage = llm.diagnose_and_fix(fb, cfg['translation_model'])
                total_usage['prompt_tokens'] += usage.get('prompt_tokens', 0)
                total_usage['completion_tokens'] += usage.get('completion_tokens', 0)
                total_usage['total_tokens'] += usage.get('total_tokens', 0)
                fixes = json.loads(raw)
                all_fixes.extend(fixes)
            except Exception as e:
                logger.warning("AI 修复第 %d 批失败: %s", bi + 1, e)

        # 自动应用修复
        applied = 0
        skipped_indices = []

        def _tc_to_sec(t: str) -> float:
            t = t.replace(',', '.').strip()
            parts = t.split(':')
            if len(parts) == 3:
                return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
            return 0.0

        def _gap_seconds(tc_a: str, tc_b: str) -> float:
            """计算 tc_a 的结束时间 到 tc_b 的开始时间 的间隔（秒）"""
            end_a = _tc_to_sec(tc_a.split('-->')[1])
            start_b = _tc_to_sec(tc_b.split('-->')[0])
            return start_b - end_a

        max_gap = cfg.get('merge_max_gap', 0.5)  # 默认 500ms
        already_merged = set()  # 已参与合并的条目索引，防止重复合并

        logger.info("=" * 60)
        logger.info("AI 修复详情（共 %d 条诊断结果）", len(all_fixes))
        logger.info("=" * 60)
        for fix in all_fixes:
            idx = fix.get('index')
            action = fix.get('action', 'skip')
            reason = fix.get('reason', '')
            entry = entry_map.get(idx)
            if not entry or action == 'skip':
                if action == 'skip':
                    skipped_indices.append(idx)
                    logger.info("[#%s] SKIP - AI确认无问题 | 原因: %s", idx, reason)
                continue

            # 已参与过合并的条目跳过
            if idx in already_merged:
                logger.info("[#%s] 跳过（已参与过合并）", idx)
                continue

            pos = idx_to_pos.get(idx)
            if pos is None:
                continue

            old_text = entry.text

            if action == 'merge_up' and pos > 0:
                prev_e = sorted_entries[pos - 1]
                if prev_e.index in already_merged:
                    logger.info("[#%s] MERGE_UP 被拦截（目标 #%s 已参与过合并）", idx, prev_e.index)
                    continue
                gap = _gap_seconds(prev_e.timecode, entry.timecode)
                if gap > max_gap:
                    logger.info("[#%s] MERGE_UP 被拦截（间隔 %.3fs > %.3fs）| 原因: %s", idx, gap, max_gap, reason)
                    continue
                prev_old_text = prev_e.text
                prev_old_tc = prev_e.timecode
                prev_lines = prev_e.text.split('\n')
                cur_lines = entry.text.split('\n')
                prev_source = prev_lines[0] if prev_lines else ''
                cur_source = cur_lines[0] if cur_lines else ''
                merged_source = prev_source + ' ' + cur_source
                # 用翻译 API 重新翻译合并后的原文
                new_translation = ''
                try:
                    temp_entry = SubtitleEntry(prev_e.index, prev_e.timecode, merged_source)
                    raw, retrans_usage = llm.translate_batch([temp_entry], cfg['translation_model'])
                    translations = SRTBackend._align(raw, [temp_entry])
                    new_translation = translations[0] if translations else ''
                    total_usage['prompt_tokens'] += retrans_usage.get('prompt_tokens', 0)
                    total_usage['completion_tokens'] += retrans_usage.get('completion_tokens', 0)
                    total_usage['total_tokens'] += retrans_usage.get('total_tokens', 0)
                except Exception as retrans_err:
                    logger.warning("合并重译失败 #%s: %s", idx, retrans_err)
                prev_e.text = merged_source + ('\n' + new_translation if new_translation else '')
                prev_e.timecode = prev_e.timecode.split('-->')[0].strip() + ' --> ' + entry.timecode.split('-->')[1].strip()
                entry.text = ''  # 标记为空，后续过滤
                already_merged.add(idx)
                already_merged.add(prev_e.index)
                applied += 1
                logger.info("[#%s] MERGE_UP → 合并到 #%s | 原因: %s", idx, sorted_entries[pos - 1].index, reason)
                logger.info("  被删条目: [#%s] %s | %s", idx, entry.timecode, old_text.replace('\n', ' | '))
                logger.info("  目标修改前: [#%s] %s | %s", sorted_entries[pos - 1].index, prev_old_tc, prev_old_text.replace('\n', ' | '))
                logger.info("  目标修改后: [#%s] %s | %s", sorted_entries[pos - 1].index, prev_e.timecode, prev_e.text.replace('\n', ' | '))

            elif action == 'merge_down' and pos < len(sorted_entries) - 1:
                next_e = sorted_entries[pos + 1]
                if next_e.index in already_merged:
                    logger.info("[#%s] MERGE_DOWN 被拦截（目标 #%s 已参与过合并）", idx, next_e.index)
                    continue
                gap = _gap_seconds(entry.timecode, next_e.timecode)
                if gap > max_gap:
                    logger.info("[#%s] MERGE_DOWN 被拦截（间隔 %.3fs > %.3fs）| 原因: %s", idx, gap, max_gap, reason)
                    continue
                next_old_text = next_e.text
                next_old_tc = next_e.timecode
                next_lines = next_e.text.split('\n')
                cur_lines = entry.text.split('\n')
                cur_source = cur_lines[0] if cur_lines else ''
                next_source = next_lines[0] if next_lines else ''
                merged_source = cur_source + ' ' + next_source
                # 用翻译 API 重新翻译合并后的原文
                new_translation = ''
                try:
                    temp_entry = SubtitleEntry(entry.index, entry.timecode, merged_source)
                    raw, retrans_usage = llm.translate_batch([temp_entry], cfg['translation_model'])
                    translations = SRTBackend._align(raw, [temp_entry])
                    new_translation = translations[0] if translations else ''
                    total_usage['prompt_tokens'] += retrans_usage.get('prompt_tokens', 0)
                    total_usage['completion_tokens'] += retrans_usage.get('completion_tokens', 0)
                    total_usage['total_tokens'] += retrans_usage.get('total_tokens', 0)
                except Exception as retrans_err:
                    logger.warning("合并重译失败 #%s: %s", idx, retrans_err)
                next_e.text = merged_source + ('\n' + new_translation if new_translation else '')
                next_e.timecode = entry.timecode.split('-->')[0].strip() + ' --> ' + next_e.timecode.split('-->')[1].strip()
                entry.text = ''  # 标记为空
                already_merged.add(idx)
                already_merged.add(next_e.index)
                applied += 1
                logger.info("[#%s] MERGE_DOWN → 合并到 #%s | 原因: %s", idx, sorted_entries[pos + 1].index, reason)
                logger.info("  被删条目: [#%s] %s | %s", idx, entry.timecode, old_text.replace('\n', ' | '))
                logger.info("  目标修改前: [#%s] %s | %s", sorted_entries[pos + 1].index, next_old_tc, next_old_text.replace('\n', ' | '))
                logger.info("  目标修改后: [#%s] %s | %s", sorted_entries[pos + 1].index, next_e.timecode, next_e.text.replace('\n', ' | '))

        logger.info("=" * 60)
        logger.info("AI 修复完成: 共 %d 个问题，已修复 %d 个，AI确认无问题 %d 个",
                    len(all_fixes), applied, len(skipped_indices))
        logger.info("=" * 60)

        # 重建结果（过滤空条目）
        fixed_entries = [e for e in sorted_entries if e.text.strip()]
        output = []
        for i, entry in enumerate(fixed_entries):
            output.append(f"{i + 1}\n{entry.timecode}\n{entry.text}\n")

        return {
            'fixes': all_fixes,
            'usage': total_usage,
            'applied': applied,
            'skipped': len(skipped_indices),
            'result': "\n".join(output),
        }

    @staticmethod
    def _align(response_text: str, batch: List[SubtitleEntry]) -> List[str]:
        # 按行解析 AI 返回，同时建立序号映射和按顺序的列表
        index_map = {}
        order_list = []
        for line in response_text.split('\n'):
            parts = line.split('|')
            if len(parts) >= 3:
                translation = parts[2].strip()
                order_list.append(translation)
                try:
                    idx = int(re.sub(r'[^\d]', '', parts[0]))
                    index_map[idx] = translation
                except (ValueError, IndexError):
                    pass
        # 同时建立原文映射（用于兜底）
        text_map = {}
        for line in response_text.split('\n'):
            parts = line.split('|')
            if len(parts) >= 3:
                text_map[StringUtils.normalize(parts[1].strip())] = parts[2].strip()

        # 优先用序号匹配；序号对不上时按顺序匹配；都不行用原文匹配兜底
        if len(index_map) >= len(batch) * 0.8:
            return [index_map.get(e.index, "") for e in batch]
        if len(order_list) == len(batch):
            return order_list
        return [text_map.get(StringUtils.normalize(e.text), "") for e in batch]


# ==================== Flask 应用 ====================

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 4 * 1024 * 1024 * 1024  # 4 GB

# ==================== 转录任务 ====================

_transcription_tasks: Dict[str, dict] = {}

# ==================== 翻译任务 ====================

_translation_tasks: Dict[str, dict] = {}


def _run_translation_task(task_id: str, srt_content: str, cfg: dict):
    task = _translation_tasks[task_id]
    try:
        def progress_cb(done: int, total: int):
            task.update({
                'progress': round(done / total * 100) if total else 0,
                'message': f'正在翻译第 {done}/{total} 批...',
            })
        result = SRTBackend.run_translation(srt_content, cfg, progress_cb=progress_cb)
        task.update({'status': 'done', 'result': result['result'], 'usage': result['usage']})
    except Exception as e:
        task.update({'status': 'error', 'error': str(e)})


# ==================== 一键翻译任务 ====================

_oneclick_tasks: Dict[str, dict] = {}


def _run_oneclick_task(task_id: str, srt_content: str, cfg: dict):
    task = _oneclick_tasks[task_id]
    total_usage = {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}

    def _add_usage(usage):
        total_usage['prompt_tokens'] += usage.get('prompt_tokens', 0)
        total_usage['completion_tokens'] += usage.get('completion_tokens', 0)
        total_usage['total_tokens'] += usage.get('total_tokens', 0)

    try:
        entries = SRTBackend.parse_from_string(srt_content)
        if not entries:
            task.update({'status': 'error', 'error': '未解析到有效字幕'})
            return

        # ---- 阶段 1：内容分析（可选） ----
        analysis_result = None
        glossary_hint = ""
        if cfg.get('enable_content_analysis', True):
            task.update({'stage': 'analyzing', 'message': '正在分析内容，生成术语表...', 'progress': 0})
            analysis_result = SRTBackend.run_content_analysis(entries, cfg)
            glossary_hint = SRTBackend._build_glossary_hint(analysis_result)
            if analysis_result:
                _add_usage(analysis_result['usage'])
                analysis_info = analysis_result.get('analysis', {})
                domain = analysis_info.get('domain', '未知')
                glossary_count = len(analysis_info.get('glossary', []))
                task.update({'message': f'分析完成: {domain}领域, {glossary_count}个术语'})
                logger.info("一键翻译 - 术语表: %s", glossary_hint or '(无)')
        else:
            logger.info("一键翻译 - 已跳过内容分析（用户配置）")

        # ---- 阶段 2：并行翻译 ----
        task.update({'stage': 'translating', 'message': '正在翻译...', 'progress': 0})

        def translate_progress(done, total):
            task.update({
                'progress': round(done / total * 100) if total else 0,
                'message': f'正在翻译第 {done}/{total} 批...',
            })

        trans_result = SRTBackend.run_translation(
            srt_content, cfg, progress_cb=translate_progress, glossary_hint=glossary_hint)
        _add_usage(trans_result['usage'])
        translated_srt = trans_result['result']

        # ---- 阶段 2.5：去重修复（纯程序，无 API） ----
        translated_entries = SRTBackend.parse_from_string(translated_srt)
        dedup_min_overlap = cfg.get('dedup_min_overlap', 8)
        dedup_fixed = SRTBackend.run_dedup_fix(translated_entries, dedup_min_overlap)
        if dedup_fixed > 0:
            output = []
            for i, e in enumerate(sorted(translated_entries, key=lambda x: x.index)):
                output.append(f"{i + 1}\n{e.timecode}\n{e.text}\n")
            translated_srt = "\n".join(output)
            logger.info("去重修复完成，共修复 %d 条重复译文", dedup_fixed)
            task.update({'message': f'去重修复 {dedup_fixed} 条'})

        # ---- 阶段 3：质量检测 ----
        task.update({'stage': 'checking', 'message': '正在质量检测...', 'progress': 0})
        translated_entries = SRTBackend.parse_from_string(translated_srt)
        min_chars = cfg.get('min_chinese_chars', 5)
        min_dur = cfg.get('min_duration', 0.5)
        problems = SRTBackend.run_quality_check(translated_entries, min_chars, min_dur)
        task.update({'message': f'检测到 {len(problems)} 条问题字幕'})

        # ---- 阶段 4：AI 智能修复 ----
        fix_result = None
        if problems:
            task.update({'stage': 'fixing', 'message': f'正在 AI 修复 {len(problems)} 条问题字幕...', 'progress': 0})
            fix_result = SRTBackend.run_ai_fix(translated_entries, problems, cfg)
            _add_usage(fix_result['usage'])
            translated_srt = fix_result.get('result', translated_srt)
            task.update({
                'message': f'修复完成: 已修复 {fix_result["applied"]} 条, AI确认无问题 {fix_result["skipped"]} 条'
            })

        # ---- 完成 ----
        task.update({
            'status': 'done',
            'stage': 'done',
            'result': translated_srt,
            'usage': total_usage,
            'analysis': analysis_result.get('analysis') if analysis_result else None,
            'problems_found': len(problems),
            'fixes_applied': fix_result['applied'] if fix_result else 0,
            'fixes_skipped': fix_result['skipped'] if fix_result else 0,
        })
    except Exception as e:
        logger.error("一键翻译失败: %s", e, exc_info=True)
        task.update({'status': 'error', 'error': str(e)})


def _seconds_to_srt_time(s: float) -> str:
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    ms = int(round((s % 1) * 1000))
    return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"


# ==================== 转录辅助函数 ====================

_NOISE_PATTERN = re.compile(r'^\s*[\[\(（【♪♫].*[\]\)）】♪♫]?\s*$')
_NOISE_WORDS = {'music', 'applause', 'laughter', 'silence', '音乐', '掌声', '笑声', '鼓掌'}


def _is_noise_marker(text: str) -> bool:
    """过滤音乐/噪音标记，如 [Music]、【音乐】、(applause) 等"""
    text = text.strip()
    if not text:
        return True
    if _NOISE_PATTERN.match(text):
        return True
    return text.strip('[]()（）【】♪♫ ').lower() in _NOISE_WORDS


def _is_mainly_cjk(text: str) -> bool:
    """判断文本是否主要是中日韩文字"""
    cjk = sum(1 for c in text if '\u4e00' <= c <= '\u9fff'
              or '\u3040' <= c <= '\u30ff' or '\uac00' <= c <= '\ud7af')
    total = len(text.replace(' ', ''))
    return cjk / max(total, 1) > 0.3


def _split_segment_by_sentences(segment, max_chars_cjk=30, max_chars_latin=80):
    """智能断句：按标点 + 时间间隔 + 最大字符数拆分 segment，返回 [(start, end, text), ...]"""
    words = getattr(segment, 'words', None)
    if not words:
        return [(segment.start, segment.end, segment.text.strip())]

    SENTENCE_END = '.!?。！？；;'
    CLAUSE_END = ',，、：:'
    MAX_GAP = 0.7  # 词间超过此秒数则强制断句

    results = []
    current = []

    def flush():
        nonlocal current
        if current:
            text = ''.join(w.word for w in current).strip()
            if text:
                results.append((current[0].start, current[-1].end, text))
            current = []

    for i, w in enumerate(words):
        current.append(w)
        text_so_far = ''.join(x.word for x in current).strip()
        is_cjk = _is_mainly_cjk(text_so_far)
        max_chars = max_chars_cjk if is_cjk else max_chars_latin
        word_text = w.word.rstrip()

        # 1. 句末标点 → 断句
        if word_text and word_text[-1] in SENTENCE_END:
            flush()
            continue

        # 2. 与下一个词的时间间隔过大 → 断句
        if i + 1 < len(words) and words[i + 1].start - w.end > MAX_GAP:
            flush()
            continue

        # 3. 接近字数上限时遇到分句标点 → 断句
        if len(text_so_far) >= max_chars * 0.7 and word_text and word_text[-1] in CLAUSE_END:
            flush()
            continue

        # 4. 硬上限 → 强制断句
        if len(text_so_far) >= max_chars:
            flush()
            continue

    flush()
    return results if results else [(segment.start, segment.end, segment.text.strip())]


def _merge_short_entries(entries: list, max_chars_cjk: int = 30, max_chars_latin: int = 80,
                         max_merge_gap_s: float = 1.5) -> list:
    """合并过短的字幕条目到相邻条目（复刻 VideoCaptioner merge_short_segment 逻辑）"""
    if len(entries) < 2:
        return entries

    MIN_CJK = 5    # CJK 文本少于此字数则视为短句
    MIN_LATIN = 3  # 拉丁文本少于此单词数则视为短句

    def _char_count(text):
        return len(text.strip())

    def _word_count(text):
        return len(text.strip().split())

    def _is_short(text):
        if _is_mainly_cjk(text):
            return _char_count(text) < MIN_CJK
        return _word_count(text) < MIN_LATIN

    def _merged_len(text):
        if _is_mainly_cjk(text):
            return _char_count(text)
        return _word_count(text)

    def _max_len(text):
        return max_chars_cjk if _is_mainly_cjk(text) else max_chars_latin

    def _join(t1, t2):
        if _is_mainly_cjk(t1 + t2):
            return t1 + t2
        return t1 + ' ' + t2

    # 多轮合并，直到没有变化
    changed = True
    while changed:
        changed = False
        i = 0
        while i < len(entries):
            start, end, text = entries[i]
            if not _is_short(text) or len(entries) < 2:
                i += 1
                continue

            # 尝试与下一条合并
            merged_down = False
            if i + 1 < len(entries):
                ns, ne, nt = entries[i + 1]
                gap = ns - end
                merged = _join(text, nt)
                if gap < max_merge_gap_s and _merged_len(merged) <= _max_len(merged):
                    entries[i] = (start, ne, merged)
                    entries.pop(i + 1)
                    changed = True
                    merged_down = True

            # 如果没和下一条合并，尝试与上一条合并
            if not merged_down and i > 0:
                ps, pe, pt = entries[i - 1]
                gap = start - pe
                merged = _join(pt, text)
                if gap < max_merge_gap_s and _merged_len(merged) <= _max_len(merged):
                    entries[i - 1] = (ps, end, merged)
                    entries.pop(i)
                    changed = True
                    continue

            i += 1

    return entries


def _optimize_subtitle_timing(entries: list, threshold_s: float = 1.0) -> list:
    """优化字幕时间轴：缩小相邻字幕间隙，避免字幕闪烁"""
    for i in range(len(entries) - 1):
        start, end, text = entries[i]
        next_start = entries[i + 1][0]
        gap = next_start - end
        if 0 < gap < threshold_s:
            entries[i] = (start, end + gap * 0.75, text)
    return entries


# ==================== CLI 模式 ====================

_BASE_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
_TOOLS_CLI_EXE = _BASE_DIR / 'tools' / 'faster-whisper-xxl' / 'faster-whisper-xxl.exe'

_VC_REL_EXE = Path('VideoCaptioner') / 'resource' / 'bin' / 'Faster-Whisper-XXL' / 'faster-whisper-xxl.exe'
_VC_REL_MODELS = Path('VideoCaptioner') / 'AppData' / 'models'
# VideoCaptioner 可能安装在任意盘符的任意目录，扫常见子路径
_VC_COMMON_SUBDIRS = [
    Path('内训视频翻译工具') / '其他工具' / _VC_REL_EXE,  # D:\内训视频翻译工具\其他工具\VideoCaptioner\...
    Path('其他工具') / _VC_REL_EXE,                       # D:\xxx\其他工具\VideoCaptioner\...
    _VC_REL_EXE,                                           # D:\xxx\VideoCaptioner\...
]
_VC_COMMON_MODEL_SUBDIRS = [
    Path('内训视频翻译工具') / '其他工具' / _VC_REL_MODELS,
    Path('其他工具') / _VC_REL_MODELS,
    _VC_REL_MODELS,
]


def _cli_candidate_paths() -> list:
    paths = []
    # 1. 本地 tools/ 目录（一键下载后的位置）
    paths.append(_TOOLS_CLI_EXE)
    # 2. AppData/LocalAppData 下的 VideoCaptioner
    for env_var in ('APPDATA', 'LOCALAPPDATA'):
        root = os.environ.get(env_var, '')
        if root:
            paths.append(Path(root) / _VC_REL_EXE)
    # 3. 脚本目录及上级目录
    for root in (_BASE_DIR, _BASE_DIR.parent, _BASE_DIR.parent.parent):
        for sub in _VC_COMMON_SUBDIRS:
            paths.append(root / sub)
    # 4. 扫 C-Z 盘根目录常见子路径（兜底）
    for drive in 'CDEFGHIJKLMNOPQRSTUVWXYZ':
        dr = Path(f'{drive}:\\')
        if dr.exists():
            for sub in _VC_COMMON_SUBDIRS:
                paths.append(dr / sub)
    return paths


def _cli_model_dir_candidates() -> list:
    dirs = []
    for env_var in ('APPDATA', 'LOCALAPPDATA'):
        root = os.environ.get(env_var, '')
        if root:
            dirs.append(Path(root) / _VC_REL_MODELS)
    for root in (_BASE_DIR, _BASE_DIR.parent, _BASE_DIR.parent.parent):
        for sub in _VC_COMMON_MODEL_SUBDIRS:
            dirs.append(root / sub)
    for drive in 'CDEFGHIJKLMNOPQRSTUVWXYZ':
        dr = Path(f'{drive}:\\')
        if dr.exists():
            for sub in _VC_COMMON_MODEL_SUBDIRS:
                dirs.append(dr / sub)
    return dirs


def _find_cli_exe(hint: str = '') -> str:
    """查找 faster-whisper-xxl CLI，返回路径或空字符串。
    优先级：配置路径 > PATH > 本地 tools/ > AppData VideoCaptioner > 脚本目录附近
    """
    # 1. 用户在设置里指定的路径
    if hint and os.path.isfile(hint):
        return hint
    # 2. 检查 PATH
    for name in ('faster-whisper-xxl', 'faster-whisper-xxl.exe'):
        found = shutil.which(name)
        if found:
            return found
    # 3. 候选路径列表
    for p in _cli_candidate_paths():
        if p.exists():
            return str(p)
    return ''


def _find_cli_model_dir(hint: str = '') -> str:
    """查找 CLI 模型目录。优先级：配置路径 > AppData VideoCaptioner > 脚本目录附近"""
    if hint and os.path.isdir(hint):
        return hint
    for p in _cli_model_dir_candidates():
        if p.exists():
            return str(p)
    return ''


def _auto_detect_and_save_cli():
    """启动时自动检测 CLI，如果找到且配置为空则自动保存"""
    cfg = load_config()
    changed = False
    if not cfg.get('whisper_cli_exe'):
        found = _find_cli_exe()
        if found:
            cfg['whisper_cli_exe'] = found
            changed = True
            logger.info('[自动检测] 找到 CLI: %s', found)
    if not cfg.get('whisper_cli_model_dir'):
        found_dir = _find_cli_model_dir()
        if found_dir:
            cfg['whisper_cli_model_dir'] = found_dir
            changed = True
            logger.info('[自动检测] 找到模型目录: %s', found_dir)
    if changed:
        save_config(cfg)


def _run_transcription_cli(task_id: str, file_path: str, opts: dict):
    """使用 faster-whisper-xxl CLI 转录（与 VideoCaptioner 相同方式）"""
    task = _transcription_tasks[task_id]
    try:
        cli_exe = opts.get('cli_exe') or _find_cli_exe()
        if not cli_exe or not os.path.isfile(cli_exe):
            task.update({'status': 'error', 'error': f'未找到 faster-whisper-xxl 程序: {cli_exe}'})
            return

        model_name = opts.get('model', 'large-v2')
        model_dir = opts.get('cli_model_dir') or _find_cli_model_dir()
        device = opts.get('device', 'cuda')
        language = opts.get('language', 'auto')
        beam_size = int(opts.get('beam_size', 5))
        vad_filter = opts.get('vad_filter', True)
        vad_threshold = float(opts.get('vad_threshold', 0.40))
        min_silence_ms = int(opts.get('min_silence_ms', 300))
        ff_mdx_kim2 = opts.get('ff_mdx_kim2', False)
        initial_prompt = opts.get('initial_prompt', '')

        # 检测语言类型确定 max_line_width（auto 时用 30，对拉丁语只是句子短些，不丢内容）
        is_latin_lang = language in ('en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'pl', 'ru')
        max_line_width = 90 if is_latin_lang else 30

        task.update({'status': 'loading', 'message': f'正在加载 {model_name} 模型...'})

        # 创建临时工作目录
        temp_dir = Path(tempfile.mkdtemp(prefix='whisper_'))
        try:
            # 拷贝文件到临时目录（CLI 在源文件旁输出）
            src_ext = os.path.splitext(file_path)[1] or '.wav'
            wav_path = temp_dir / f'audio{src_ext}'
            shutil.copy2(file_path, wav_path)
            output_srt = wav_path.with_suffix('.srt')

            # 构建命令行
            cmd = [
                cli_exe,
                '-m', model_name,
                '--print_progress',
                str(wav_path),
                '-d', device,
                '--output_format', 'srt',
                '-o', 'source',
                '--beam_size', str(beam_size),
                '--sentence',
                '--max_line_width', str(max_line_width),
                '--max_line_count', '1',
                '--max_comma', '20',
                '--max_comma_cent', '50',
                '--beep_off',
            ]

            if model_dir:
                cmd.extend(['--model_dir', model_dir])

            if language and language != 'auto':
                cmd.extend(['-l', language])

            # VAD
            if vad_filter:
                cmd.extend([
                    '--vad_filter', 'true',
                    '--vad_threshold', f'{vad_threshold:.2f}',
                    '--vad_min_silence_duration_ms', str(min_silence_ms),
                ])
            else:
                cmd.extend(['--vad_filter', 'false'])

            # 人声分离
            if ff_mdx_kim2:
                cmd.append('--ff_mdx_kim2')

            # 提示词
            if initial_prompt and initial_prompt.strip():
                cmd.extend(['--initial_prompt', initial_prompt.strip()])

            logger.info('Faster-Whisper CLI 命令: %s', ' '.join(cmd))
            task.update({'status': 'loading', 'message': '加载模型中...'})

            # 启动子进程
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='ignore',
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
            )

            is_finish = False
            error_msg = ''
            _model_loaded = False

            while proc.poll() is None:
                line = proc.stdout.readline().strip()
                if not line:
                    continue
                # 解析进度
                m = re.search(r'(\d+)%', line)
                if m:
                    pct = int(m.group(1))
                    if not _model_loaded:
                        # 模型加载阶段
                        task['status'] = 'loading'
                        task['progress'] = pct
                        task['message'] = f'加载模型中... {pct}%'
                        if pct >= 100:
                            _model_loaded = True
                            task.update({'status': 'transcribing', 'progress': 0, 'message': '正在转录...'})
                    else:
                        # 转录阶段
                        mapped = int(5 + pct * 0.9)
                        task['progress'] = mapped
                        task['message'] = f'转录中... {mapped}%'
                        if pct >= 100:
                            is_finish = True
                if 'Subtitles are written to' in line:
                    is_finish = True
                    task['progress'] = 100
                    task['message'] = '识别完成'
                if 'error' in line.lower():
                    error_msg += line + '\n'
                    logger.error('CLI: %s', line)
                else:
                    logger.info('CLI: %s', line)

            proc.communicate()

            if not is_finish and proc.returncode != 0:
                raise RuntimeError(f'CLI 执行失败 (code={proc.returncode}): {error_msg}')

            if not output_srt.exists():
                raise RuntimeError(f'CLI 未生成输出文件: {output_srt}')

            srt_text = output_srt.read_text(encoding='utf-8')

            # 过滤噪音标记
            filtered_blocks = []
            for block in srt_text.strip().split('\n\n'):
                lines = block.strip().split('\n')
                if len(lines) >= 3:
                    text_part = '\n'.join(lines[2:])
                    if not _is_noise_marker(text_part):
                        filtered_blocks.append(block)

            # 重新编号
            renumbered = []
            for idx, block in enumerate(filtered_blocks, 1):
                lines = block.strip().split('\n')
                lines[0] = str(idx)
                renumbered.append('\n'.join(lines))

            final_srt = '\n\n'.join(renumbered) + '\n'
            count = len(renumbered)

            task.update({
                'status': 'done',
                'progress': 100,
                'message': f'完成，共 {count} 条字幕',
                'result': final_srt,
            })
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    except Exception as e:
        logger.exception('CLI 转录失败')
        task.update({'status': 'error', 'error': str(e)})
    finally:
        try:
            os.remove(file_path)
        except Exception:
            pass


def _do_transcribe(model, file_path, transcribe_kwargs, word_timestamps, task, info_holder):
    """执行一次转录并收集结果，返回 (entries, info)"""
    segments, info = model.transcribe(file_path, **transcribe_kwargs)
    info_holder['info'] = info

    entries = []
    for segment in segments:
        if info.duration > 0:
            real_pct = round(min(segment.end / info.duration * 100, 99), 1)
            task['progress'] = real_pct
            task['message'] = f'转录中... {real_pct}%'
        if word_timestamps:
            sub_entries = _split_segment_by_sentences(segment)
        else:
            sub_entries = [(segment.start, segment.end, segment.text.strip())]
        for start, end, text in sub_entries:
            if not _is_noise_marker(text):
                entries.append((start, end, text))
    return entries


def _run_transcription(task_id: str, file_path: str, opts: dict):
    """执行转录任务，根据引擎设置选择 CLI 或 Python 库"""
    engine = opts.get('engine', 'auto')
    if engine == 'cli' or (engine == 'auto' and _find_cli_exe()):
        return _run_transcription_cli(task_id, file_path, opts)
    return _run_transcription_py(task_id, file_path, opts)


def _run_transcription_py(task_id: str, file_path: str, opts: dict):
    """使用 Python faster-whisper 库转录（备选方案）"""
    task = _transcription_tasks[task_id]
    try:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            task.update({'status': 'error', 'error': '请先安装 faster-whisper：pip install faster-whisper'})
            return

        model_name = opts.get('model', 'large-v2')
        device = opts.get('device', 'cuda')
        language = opts.get('language', 'auto')
        beam_size = int(opts.get('beam_size', 5))
        word_timestamps = opts.get('word_timestamps', True)
        vad_filter = opts.get('vad_filter', True)
        vad_threshold = float(opts.get('vad_threshold', 0.40))
        min_silence_ms = int(opts.get('min_silence_ms', 300))
        initial_prompt = opts.get('initial_prompt', '')

        task.update({'status': 'loading', 'message': f'正在加载 {model_name} 模型...'})
        compute_type = "float16" if device == "cuda" else "int8"
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        task.update({'status': 'transcribing', 'message': '正在转录...'})

        transcribe_kwargs = {
            'beam_size': beam_size,
            'word_timestamps': word_timestamps,
            'vad_filter': vad_filter,
        }
        if vad_filter:
            transcribe_kwargs['vad_parameters'] = {
                'threshold': vad_threshold,
                'min_silence_duration_ms': min_silence_ms,
                'max_speech_duration_s': 30.0,
            }
        if language and language != 'auto':
            transcribe_kwargs['language'] = language
        if initial_prompt and initial_prompt.strip():
            transcribe_kwargs['initial_prompt'] = initial_prompt.strip()

        info_holder = {}
        entries = _do_transcribe(model, file_path, transcribe_kwargs, word_timestamps, task, info_holder)
        info = info_holder['info']

        # VAD 智能检测：如果 VAD 过滤掉了超过 50% 的音频，自动关闭 VAD 重新转录
        if vad_filter and info.duration > 0 and entries:
            total_speech = sum(e - s for s, e, _ in entries)
            speech_ratio = total_speech / info.duration
            if speech_ratio < 0.25:
                logger.warning(f'VAD 仅保留了 {speech_ratio:.0%} 的音频（可能是音乐/歌曲），自动关闭 VAD 重试')
                task['message'] = 'VAD 过滤过多，关闭 VAD 重新转录...'
                task['progress'] = 0
                transcribe_kwargs['vad_filter'] = False
                transcribe_kwargs.pop('vad_parameters', None)
                entries = _do_transcribe(model, file_path, transcribe_kwargs, word_timestamps, task, info_holder)
        elif vad_filter and not entries and info.duration > 0:
            # VAD 过滤掉了所有内容
            logger.warning('VAD 过滤掉了所有音频，自动关闭 VAD 重试')
            task['message'] = 'VAD 过滤掉了所有内容，关闭 VAD 重新转录...'
            task['progress'] = 0
            transcribe_kwargs['vad_filter'] = False
            transcribe_kwargs.pop('vad_parameters', None)
            entries = _do_transcribe(model, file_path, transcribe_kwargs, word_timestamps, task, info_holder)

        # 后处理：合并短句（复刻 VideoCaptioner 的 merge_short_segment）
        entries = _merge_short_entries(entries)

        # 优化字幕时间轴
        entries = _optimize_subtitle_timing(entries)

        # 生成 SRT
        srt_parts = []
        for idx, (start, end, text) in enumerate(entries, 1):
            srt_parts.append(
                f"{idx}\n{_seconds_to_srt_time(start)} --> {_seconds_to_srt_time(end)}\n{text}"
            )
        task.update({
            'status': 'done',
            'progress': 100,
            'message': f'完成，共 {len(entries)} 条字幕',
            'result': "\n\n".join(srt_parts) + "\n"
        })
    except Exception as e:
        task.update({'status': 'error', 'error': str(e)})
    finally:
        try:
            os.remove(file_path)
        except Exception:
            pass


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/logs')
def get_logs():
    offset = int(request.args.get('offset', 0))
    with _log_buffer_lock:
        lines = _log_buffer[offset:]
        total = len(_log_buffer)
    return jsonify({'lines': lines, 'total': total})


@app.route('/api/config', methods=['GET'])
def get_config():
    cfg = load_config()
    return jsonify(cfg)


@app.route('/api/config', methods=['POST'])
def set_config():
    data = request.get_json()
    cfg = load_config()
    cfg.update(data)
    save_config(cfg)
    return jsonify({'status': 'ok'})


@app.route('/api/analyze', methods=['POST'])
def analyze():
    data = request.get_json()
    srt_content = data.get('content', '')
    prompt = data.get('prompt', '')
    cfg = load_config()
    try:
        result = SRTBackend.run_analysis(srt_content, prompt, cfg)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/translate', methods=['POST'])
def translate():
    data = request.get_json()
    srt_content = data.get('content', '')
    cfg = load_config()
    task_id = uuid.uuid4().hex
    _translation_tasks[task_id] = {
        'status': 'running', 'progress': 0,
        'message': '准备中...', 'result': None, 'usage': None, 'error': None
    }
    threading.Thread(target=_run_translation_task,
                     args=(task_id, srt_content, cfg),
                     daemon=True).start()
    return jsonify({'task_id': task_id})


@app.route('/api/translate/status/<task_id>', methods=['GET'])
def translate_status(task_id):
    task = _translation_tasks.get(task_id)
    if not task:
        return jsonify({'error': '任务不存在'}), 404
    return jsonify(task)


@app.route('/api/oneclick', methods=['POST'])
def oneclick_translate():
    data = request.get_json()
    srt_content = data.get('content', '')
    cfg = load_config()
    task_id = uuid.uuid4().hex
    _oneclick_tasks[task_id] = {
        'status': 'running', 'stage': 'preparing', 'progress': 0,
        'message': '准备中...', 'result': None, 'usage': None, 'error': None,
        'analysis': None, 'problems_found': 0, 'fixes_applied': 0, 'fixes_skipped': 0,
    }
    threading.Thread(target=_run_oneclick_task,
                     args=(task_id, srt_content, cfg),
                     daemon=True).start()
    return jsonify({'task_id': task_id})


@app.route('/api/oneclick/status/<task_id>', methods=['GET'])
def oneclick_status(task_id):
    task = _oneclick_tasks.get(task_id)
    if not task:
        return jsonify({'error': '任务不存在'}), 404
    return jsonify(task)


@app.route('/api/transcribe/start', methods=['POST'])
def transcribe_start():
    if 'file' not in request.files:
        return jsonify({'error': '未上传文件'}), 400
    f = request.files['file']
    cfg = load_config()
    opts = {
        'engine': request.form.get('engine', cfg.get('whisper_engine', 'auto')),
        'model': request.form.get('model', cfg.get('whisper_model', 'large-v2')),
        'device': request.form.get('device', cfg.get('whisper_device', 'cuda')),
        'language': request.form.get('language', cfg.get('whisper_language', 'auto')),
        'beam_size': request.form.get('beam_size', cfg.get('whisper_beam_size', 5)),
        'word_timestamps': request.form.get('word_timestamps', 'true').lower() == 'true',
        'vad_filter': request.form.get('vad_filter', 'true').lower() == 'true',
        'vad_threshold': request.form.get('vad_threshold', cfg.get('whisper_vad_threshold', 0.40)),
        'min_silence_ms': request.form.get('min_silence_ms', cfg.get('whisper_min_silence_ms', 300)),
        'ff_mdx_kim2': request.form.get('ff_mdx_kim2', 'false').lower() == 'true',
        'initial_prompt': request.form.get('initial_prompt', cfg.get('whisper_prompt', '')),
        'cli_exe': _find_cli_exe(cfg.get('whisper_cli_exe', '')),
        'cli_model_dir': _find_cli_model_dir(cfg.get('whisper_cli_model_dir', '')),
    }
    suffix = os.path.splitext(f.filename)[1] if f.filename else '.tmp'
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    f.save(tmp_path)
    task_id = uuid.uuid4().hex
    _transcription_tasks[task_id] = {
        'status': 'pending', 'progress': 0,
        'message': '等待开始...', 'result': None, 'error': None
    }
    threading.Thread(target=_run_transcription,
                     args=(task_id, tmp_path, opts),
                     daemon=True).start()
    return jsonify({'task_id': task_id})


@app.route('/api/transcribe/status/<task_id>', methods=['GET'])
def transcribe_status(task_id):
    task = _transcription_tasks.get(task_id)
    if not task:
        return jsonify({'error': '任务不存在'}), 404
    return jsonify(task)


@app.route('/api/transcribe/capabilities', methods=['GET'])
def transcribe_capabilities():
    """检测转录引擎可用性"""
    cfg = load_config()
    cli_exe = _find_cli_exe(cfg.get('whisper_cli_exe', ''))
    cli_model_dir = _find_cli_model_dir(cfg.get('whisper_cli_model_dir', ''))
    # 列出已下载的 CLI 模型
    cli_models = []
    if cli_model_dir:
        md = Path(cli_model_dir)
        for d in md.iterdir():
            if d.is_dir() and d.name.startswith('faster-whisper-'):
                model_bin = d / 'model.bin'
                if model_bin.exists():
                    cli_models.append(d.name.replace('faster-whisper-', ''))
    return jsonify({
        'cli_available': bool(cli_exe),
        'cli_exe': cli_exe,
        'cli_model_dir': cli_model_dir,
        'cli_models': cli_models,
        'tools_dir': str(_TOOLS_CLI_EXE.parent),
    })


@app.route('/api/open-tools-dir', methods=['POST'])
def open_tools_dir():
    """打开 tools/faster-whisper-xxl/ 目录（自动创建）"""
    d = _TOOLS_CLI_EXE.parent
    d.mkdir(parents=True, exist_ok=True)
    os.startfile(str(d))
    return jsonify({'ok': True})


if __name__ == '__main__':
    from waitress import serve
    _auto_detect_and_save_cli()
    logger.info("=" * 48)
    logger.info("  SRT 字幕翻译工作台 启动中...")
    logger.info("  http://localhost:9999")
    logger.info("  日志文件: %s", _LOG_FILE)
    logger.info("=" * 48)
    try:
        serve(app, host='0.0.0.0', port=9999)
    except Exception as e:
        logger.exception("服务器异常退出: %s", e)
        raise
