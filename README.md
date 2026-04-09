<div align="center">

# 译幕 YiMu

**先矫正，再翻译，后修复 —— 不只是翻译，而是一套完整的字幕质量工程。**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.1-brightgreen.svg)]()
[![Python](https://img.shields.io/badge/python-3.9+-yellow.svg)]()

</div>

---

大多数 AI 字幕翻译工具的做法是：语音识别 → 丢给模型翻译 → 输出。这个流程有两个根本问题：ASR 的错误会被直接翻译出去，而模型本身也会产生幻觉。

译幕通过多阶段工作流，在翻译**前**矫正 ASR 错误、生成术语表，在翻译**后**自动检测和修复问题，确保最终字幕的专业级质量。

> 当前版本已支持配置源语言与目标语言，并开放多语言翻译链路；英译中验证最充分，其他语言对建议先做小样本测试。

![译幕界面](docs/images/homepage.png)

---

## 翻译效果对比

### 与 VideoLingo 对比测试

使用同一个 17 分钟英文技术视频、同一个翻译模型，对比译幕与 [VideoLingo](https://github.com/Huanshere/VideoLingo)（16.4k Star）。

选择 VideoLingo 作为对比对象，是因为两者技术路线最接近：都使用 Whisper 进行语音转录、都通过 API 调用大模型翻译、都有术语管理机制、都关注翻译质量而非只做简单的机翻。同时它也是目前 GitHub 上同类项目中 Star 最多的之一，质量保障机制较完善（翻译→反思→适配三轮翻译），可以代表当前 AI 字幕翻译的较高水平。

**专有名词准确性 — ASR 矫正的价值：**

| 原文 | VideoLingo | 译幕 |
|------|-----------|------|
| Claude Agent SDK | ❌ **Cloud** Agent SDK | ✅ **Claude** 智能体 SDK |
| Sonnet 4.5 | ❌ **Solid** 4.5 | ✅ **Sonnet** 4.5 |
| handing off context | ❌ handing off **contacts** | ✅ 交接**上下文** |

VideoLingo 没有 ASR 矫正环节，语音识别的错误直接进入翻译。译幕在翻译前先矫正，专有名词准确率显著更高。

**翻译速度（同一翻译模型）：**

| | 译幕 | VideoLingo |
|--|------|-----------|
| 翻译流程耗时 | **约 3 分钟** | 约 10 分钟 |

**翻译风格（测试视频涉及 GAN 架构、智能体设计等专业话题）：**

| 原文 | VideoLingo | 译幕 |
|------|-----------|------|
| it's likely going to praise it | "它十有八九会把自己夸得挺好" | "它很可能会给自己好评" |
| it costs $100 to create | "这玩意儿也就花了100美元" | "它的制作成本只有100美元" |
| I'm sure they're delighted | "他们肯定高兴坏了" | "他们肯定乐见其成" |

译幕根据原文内容自动适配翻译风格。

**API 调用成本：**

| | 译幕 | VideoLingo |
|--|------|-----------|
| 翻译 API 调用 | 每条字幕 **1 次** | 每条字幕 **3 次**（翻译→反思→适配） |
| 修复 API 调用 | 仅问题条目（实测 323 条中 2 条） | 无 |

译幕的 Token 消耗远低于 VideoLingo，API 成本更低。

完整测试报告见 [comparison-report.md](docs/comparison-report.md)。

### 与其他翻译方案对比

| 其他方案 | 译幕 |
|:-------:|:----:|
| ![其他方案](docs/images/comparison/other.png) | ![译幕](docs/images/comparison/yimu.png) |
| 我们在AI工程师大会上关于12要素智能体的演讲 | 我们在 AI Engineer in June 大会上做的那个《12 要素智能体》的演讲 |

---

## 解决了什么问题？

### 问题一：语音转文字的错误会被直接翻译

语音识别（ASR）输出的文本充满错误 —— 专有名词被识别成发音相近的常见词（如 "DeepSeek" → "deep sea"），短句被碎片化切割。直接拿这些错误文本去翻译，错误会被固化到译文中，且译后几乎无法溯源修正。

### 问题二：大模型翻译存在幻觉和格式错误

LLM 在翻译字幕时会产生多种问题：

- **重复翻译** — 遇到半句话时"自动补全"，导致相邻条目译文重复拼接
- **短句跳过** — 过短的字幕条目被模型忽略，直接丢失译文
- **序号错误** — 模型输出的序号与原文不对应，导致译文错位
- **时间轴错误** — 字幕显示时机与语音不同步

---

## 多阶段工作流

译幕在翻译**前、中、后**三个阶段分别处理问题：

### 翻译前 — 修正源文本

| 阶段 | 做什么 | 解决什么 |
|------|--------|----------|
| 短句合并 | 将 ASR 产生的碎片字幕按语言规则自动合并 | 消除碎片化切割 |
| AI 语音识别矫正 | AI 分析误识别词，用户确认后批量替换 | 翻译前修正 ASR 错误 |
| 内容分析 | AI 取样字幕，识别领域，生成术语表 | 提供领域上下文和统一术语 |

### 翻译中 — 保证一致性

| 阶段 | 做什么 | 解决什么 |
|------|--------|----------|
| 术语注入 | 术语表注入每批翻译 Prompt | 跨批次术语一致 |
| 并行翻译 | 多批次并发调用 API | 提速，保持上下文 |
| 三级对齐算法 | 序号 → 顺序 → 原文归一化匹配 | 防止译文错位 |

### 翻译后 — 检测与修复

| 阶段 | 做什么 | 解决什么 |
|------|--------|----------|
| 去重修复 | 检测相邻译文重复前缀，自动裁剪 | 消除重复拼接 |
| 质量检测 | 规则检测漏翻和异常短句 | 发现遗漏 |
| AI 智能修复 | AI 仅判断方向，软件执行合并后重新翻译 | AI 不生成内容 = 无幻觉 |
| 时间间隔拦截 | 间隔 > 500ms 强制跳过合并 | 防止跨说话人合并 |

**一键触发，全自动执行。**

---

## 功能一览

| 功能 | 说明 |
|------|------|
| SRT 导入 | 拖入 `.srt` 文件即可开始 |
| 音视频转录 | 上传音视频，本地 Whisper 自动生成字幕 |
| 短句合并 | 按语言类型（CJK/Latin）合并碎片字幕 |
| AI 矫正 | 识别并修正 ASR 错误，支持多轮分析 |
| 一键翻译 | 分析 → 翻译 → 检测 → 修复，全自动 |
| 双语导出 | 源语言/目标语言上下位置可调换，预览后下载 |

---

## 什么是 SRT？

SRT 是最通用的字幕文件格式。译幕的使用流程：

1. 导入源语言 SRT 字幕（或上传音视频自动转录生成）
2. 译幕完成矫正 + 翻译，导出双语 SRT
3. 将 SRT 导入剪辑软件（Premiere Pro、DaVinci Resolve、剪映等）或播放器（PotPlayer、VLC 等）

---

## 快速开始

### 环境要求

- Windows 10/11
- Python 3.9+
- AI 模型的 API Key（支持 OpenAI 兼容接口）

### 安装

```bash
git clone https://github.com/mikuleader/YiMu-Subtitle-Translator.git
cd YiMu-Subtitle-Translator

python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

### 启动

双击 `启动工作台.bat`（推荐），或：

```bash
python app.py
```

浏览器访问 `http://localhost:9999` 即可使用。

### 配置 AI 模型

首次使用需点击右上角 **⚙ 软件设置**，配置两个模型：

| 模型 | 用途 | 已测试通过 |
|------|------|-----------|
| 分析模型 | 字幕纠错，需推理能力强 | Gemini 2.5 Flash / Pro |
| 翻译模型 | 字幕翻译，需语言表达能力强 | GPT-4o / GPT-5.1 |

两个模型可配置不同的 API Key 和 Base URL，也可分别填写：

- 额外请求头（JSON 对象）
- 额外请求体（JSON 对象）
- 源语言 / 目标语言

这适合接入需要自定义 Header、供应商扩展参数或特殊网关的 OpenAI 兼容接口。

设置面板内置 `DeepSeek`、`GLM / 智谱`、`豆包 / 火山方舟`、`OpenAI 官方` 的快速套用。其他模型未测试，欢迎尝试反馈。

### 音视频转录（可选）

已有 SRT 文件可跳过。如需从音视频生成字幕：

1. 启动脚本会自动安装 Python 依赖。只做字幕翻译时，不需要额外安装 FFmpeg 或 Whisper CLI。
2. 如需“上传音视频直接转录”，推荐下载 **Windows 可执行版** 的 Faster-Whisper CLI，而不是 GitHub 自动生成的 `Source code (zip/tar.gz)` 源码包。
3. 推荐目录结构如下，不需要手动配置系统 PATH：

```text
YiMu-Subtitle-Translator/
├─ 启动工作台.bat
├─ tools/
│  ├─ faster-whisper-xxl/
│  │  └─ faster-whisper-xxl.exe
│  └─ ffmpeg/
│     └─ bin/
│        └─ ffmpeg.exe
```

4. 下载建议：
   - **Faster-Whisper CLI**：从 [whisper-standalone-win Releases](https://github.com/Purfview/whisper-standalone-win/releases) 下载真正的 Windows release，解压后确保你最终拿到的是 `faster-whisper-xxl.exe`
   - **FFmpeg**：下载 Windows 预编译版，解压后确保你最终拿到的是 `ffmpeg.exe`
5. 本项目现在会自动检测以下几种情况：
   - 已加入系统 PATH 的 `faster-whisper-xxl.exe` / `ffmpeg.exe`
   - 放在项目 `tools/` 目录下的可执行文件
   - 用户误把 release 解压到项目根目录或其浅层子目录时的可执行文件
6. 如果你下载后只看到 `README.md`、`changelog.txt`、`.tar.xz`、`.tar`、源码目录，而没有 `faster-whisper-xxl.exe` 或 `ffmpeg.exe`，说明你下错了包。

启动后界面会自动检测转录引擎是否可用。

- 检测到 `faster-whisper-xxl CLI` 时，默认优先使用 CLI，速度更快
- 未检测到时，会自动回退到 Python `faster-whisper` 库
- 工作台可直接打开本地 `tools` 目录，方便放入 CLI 可执行文件和模型

---

## 技术架构

| 组件 | 技术 |
|------|------|
| 前端 | 原生 HTML/CSS/JS，无框架依赖 |
| 后端 | Flask + Waitress（端口 9999） |
| AI 调用 | OpenAI 兼容接口 |
| 转录 | Faster Whisper（CLI 优先，Python 库备选） |
| 数据 | 纯浏览器内存，无数据库 |

---

## 本次新增能力

- 支持在设置中分别配置源语言和目标语言，不再局限于固定英译中流程
- 分析模型和翻译模型均支持自定义额外请求头、额外请求体，便于适配不同 API 供应商
- 双语导出支持根据源语言/目标语言调整上下位置
- 转录能力增加对本地 `faster-whisper-xxl CLI` 的自动检测与优先使用
- 项目默认忽略本地 `tools/` 工具目录，避免误把大体积二进制和模型文件提交到仓库

---

## 已知局限

- 英译中验证最充分，其他语言对建议先做小样本测试
- 不支持视频烧录，仅输出 SRT 文件
- 必须配置 API Key，无免费翻译选项
- 单文件处理，暂无批量功能
- 已测试模型：Gemini 2.5 Flash/Pro（分析）、GPT-4o/GPT-5.1（翻译）。使用 OpenAI 兼容接口，理论上支持所有兼容该接口的模型（如 DeepSeek、GLM 等），但未实际验证，欢迎反馈测试结果

---

## 路线图

- [ ] 支持更多语言对（日语→中文、韩语→中文等），详见 [多语言改造清单](docs/multilang-roadmap.md)
- [ ] 更多翻译模型的测试与适配
- [ ] 批量处理

欢迎提交 Issue 反馈需求。

---

## 许可证

[MIT License](LICENSE)

---

<div align="center">

Made by [@mikuleader](https://github.com/mikuleader)

</div>
