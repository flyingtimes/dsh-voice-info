# dsh-voice-info 🔊

DeepSeek Harness 语音播报插件：主对话轮次结束后，通过配套的 [ble-speaker](../ble-speaker) CLI 连接蓝牙音箱，用 **CosyVoice 自然人声**播报任务结果，播放完**保持连接**不断开。

一句话：`agent 跑完任务 → 🔔 叮咚 →（2秒）→ 柔和女声"主人，我的任务完成了，用时3分钟"`

## 功能总览

| 类别 | 能力 |
| --- | --- |
| 🗣 语音 | 本地 CosyVoice 服务合成（41 音色，默认 `f_young_soft` 柔和女声），服务不可用自动回退系统 TTS |
| 🔔 提示音 | 人声前先播"叮咚"（纯 Node 合成），间隔 2 秒，杜绝突然出声的惊吓感 |
| 📝 文案 | 四档逐级兜底：LLM 一句话摘要 → 结果摘录 → 原因+时长模板 → 固定句 |
| 🚨 阻塞提醒 | agent 等你确认时立即播报，豁免时长/冷却/在场检查；夜间走本机扬声器 |
| 🌙 免打扰 | 静音时段（凌晨 1–7 点）/ 播报冷却 / goal 续跑合并 / 在场感知（键鼠活跃=跳过） |
| 📮 过夜摘要 | 静音时段的播报入队，早上 7 点汇总成一句播报（LLM 压缩），重启不丢 |
| ⚡ 低延迟 | 轮次进行中后台预热音箱连接；音箱休眠 25 秒快速失败转本机；新轮次自动取消迟到通知 |
| 🖥 GUI | 侧栏状态入口 + 设置面板（全部配置即时生效免重启）；HTTP 配置/自检/音色路由 |

## 播报流水线

```
turn/start ──► 后台预热音箱连接（fire-and-forget）
turn/end ──► [原因在 announceOn?] ──► [blocked? 紧急通道]
          ──► [时长≥1分钟?] ──► [静音时段? ─入队过夜摘要]
          ──► [用户在场? 键鼠活跃→跳过] ──► [冷却?]
          ──► 生成文本(fixed/template/excerpt/llm)
          ──► ble-speaker run --keep --engine cosyvoice
          ──► 🔔 叮咚 → 2s → 🗣 CosyVoice 语音
          ──► 失败？→ 本机播放 → 裸 say 兜底
新 turn/start ──► 取消一切未播/播报中的迟到通知
```

## 语音引擎（CosyVoice）

默认使用本地 [cosyvoice-server](https://github.com/)（OpenAI 兼容 API，默认 `127.0.0.1:9880`）合成语音：

- `ttsEngine: "cosyvoice"`（默认）/ `ttsVoice: "f_young_soft"` / `ttsSpeed: 1.0` / `ttsUrl`
- 41 个音色：`GET /plugin-api/voice-info/voices` 实时列出；GUI 面板音色框带下拉建议
- **自动回退**：服务未启动/超时 → 系统 `say` → 插件裸 `say` 兜底，播报永不中断
- 合成按 文本+音色+语速 哈希缓存在 ble-speaker `cache/tts/`，重复播报零等待

## 播报内容（detail）

| 模式 | 效果示例 |
| --- | --- |
| `fixed` | 「主人，我的任务完成了」 |
| `template` | 「主人，我的任务完成了，用时3分钟」／出错时「主人，任务出错了，用时2分钟」 |
| `excerpt` | 「主人，任务完成了：修复了登录超时问题」（本轮助手回复的清洗摘录） |
| `llm`（默认） | 「主人，任务完成了。修复了登录超时并补了测试」（小 LLM 调用压缩本轮结果，失败逐级回退 excerpt→template→fixed） |

## 提示音（叮咚先行）

- `chime: true`（默认开）/ `chimeDelayMs: 2000`，`chimeFile` 可换自定义音频
- 内置提示音纯 Node 合成（`assets/make-chime.mjs`：G#5→Eb5 双音指数衰减，1.25s，无第三方音源）
- 提示音在**目标输出设备**上播放（切完输出后先叮咚），与人声同设备

## 阻塞提醒（agent 在等你）

`reason=blocked`（agent 停下等确认/审批）走**紧急通道**：

- 豁免时长门槛、冷却、在场检查——等你确认的事，人在也要喊
- 夜间行为由 `blockedQuietPolicy` 决定：
  - `local`（默认）：临时切系统输出到本机扬声器 → 播报 → 切回音箱
  - `speaker`：照常音箱播报；`skip`：静音期跳过
- 文案模板 `templates.blocked` =「主人，我在等你确认，请回来处理」

## 免打扰

| 机制 | 配置 | 说明 |
| --- | --- | --- |
| 短轮次静默 | `minDurationMs: 60000` | 运行不足 1 分钟的轮次不播（blocked 豁免） |
| 静音时段 | `quietHours: ["01:00","07:00"]` | 时段内不播出声，进入过夜摘要队列；支持跨零点 |
| 播报冷却 | `cooldownMs: 90000` | 两次播报间隔小于 90 秒时跳过（blocked 豁免） |
| goal 续跑感知 | `goalAware: true` + `goalDebounceMs: 90000` | goal 自动续跑不逐轮播；90 秒无新轮次（= 目标完成）才播一次 |
| 在场感知 | `afkSkipMs: 30000` | 键鼠 30 秒内有操作 = 你在电脑前，跳过非紧急播报（结果就在屏幕上）；0 = 禁用；非 macOS 平台不拦截 |

## 过夜摘要

静音时段的播报不丢弃，入队持久化（`digest-queue.json`），**静音结束时汇总播一次**：

- `llm` 模式：整晚条目交给一次 LLM 调用合并——「主人，早上好。夜里完成了3个任务，其中1个出错」
- 其他模式：按条数与错误数生成摘要
- 进程重启不丢：重启后队列非空且已出静音时段 → 10 秒后补播；被新轮次取消 → 自动重新入队

## 低延迟设计

| 机制 | 配置 | 说明 |
| --- | --- | --- |
| 预热连接 | `prewarm: true` | turn/start 即后台预连音箱，轮次跑完时音箱已就绪、播报秒出声；休眠音箱预热提前失败，播报直走本机（静音时段不预热，1 分钟限频） |
| 快速失败 | `speakerRetries: 1` | 音箱不可达时一次尝试（约 25 秒）即放弃，立即降级本机播放 |
| 迟到取消 | `cancelOnNewTurn: true` | 新一轮开始 = 人在电脑前，未播/播报中的旧通知立即中止（杀进程、跳过回退） |

**可靠性兜底链**：音箱 → 本机 `ble-speaker play` → 裸 `say`；另有可选 `keepAlive` 定期重连防音箱休眠（默认关，会一直占用设备）。

## GUI 设置面板

侧栏底部「🔊 语音播报」入口，状态点：**绿**=就绪 / **灰**=静音时段 / **红**=上次失败 / **黄**=播报中。

面板可调：总开关、播报模式、音量、静音时段、冷却、最短轮时长、goal 感知、阻塞策略、过夜摘要、预热连接、在场跳过、提示音开关/间隔、**语音引擎/音色（带 41 音色下拉）/语速**，以及「🔈 试听」按钮（专属测试文案，不冒充完成通知）。保存即生效，无需重启（仅 keepAlive 需重启）。

## HTTP 路由

| 路由 | 用途 |
| --- | --- |
| `GET /plugin-api/voice-info/test` | 插件状态/配置/最近日志；`?announce=1` 触发试听 |
| `GET/POST /plugin-api/voice-info/config` | 读/写配置（白名单校验、持久化、即时生效） |
| `GET /plugin-api/voice-info/voices` | 代理 cosyvoice `/healthz`，列出全部可用音色 |

## 其他行为

- 只监听**主对话**（子代理会话已过滤）
- 播报串行化 + 合并：不重叠、不抢占连接
- 完全旁路（不阻塞回合收尾），失败只记日志（`/tmp/dsh-voice-info.log`）

## 安装

前置：
1. 本机已有 ble-speaker 项目（macOS 需 `brew install blueutil switchaudio-osx`；需含 `--engine cosyvoice` / `--chime` 支持的同步版本）
2. 目标音箱成功连接过一次（写入其 `devices.json` 登记簿）
3. 可选：本地 cosyvoice-server（更自然的音色；没有则自动用系统 TTS）

```bash
git clone https://github.com/flyingtimes/dsh-voice-info.git ~/code/dsh-voice-info
cd ~/code/dsh-voice-info
cp config.example.json config.json   # 改 bleSpeakerDir / device / ttsUrl
dsh plugin --profile web add ~/code/dsh-voice-info
```

包声明 `dsh.bundle.patch`（服务端）+ `dsh.client`（Web 客户端），重启 `dsh web` 后侧栏出现「🔊 语音播报」入口。

## 配置

完整配置项及逐项 `_comment` 说明见 [`config.example.json`](config.example.json)。改文件需重启 GUI；用 GUI 面板或 POST 路由即时生效。

## License

[MIT](LICENSE)
