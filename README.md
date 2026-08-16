# dsh-voice-info

DeepSeek Harness 语音播报插件：主对话轮次结束后，通过配套的 ble-speaker CLI 连接蓝牙音箱播放语音通知，播放完**保持连接**不断开。

```
turn/end ──► [原因在 announceOn?] ──► [blocked? 紧急通道] ──► [时长≥1分钟?]
          ──► [静音时段?] ──入队过夜摘要──► ──► [冷却?] ──► 生成文本(detail四档)
          ──► ble-speaker run --keep ──► 音箱播报；失败降级本机
```

## 播报内容（detail）

| 模式 | 效果示例 |
| --- | --- |
| `fixed` | 「主人，我的任务完成了」 |
| `template` | 「主人，我的任务完成了，用时3分钟」／出错时「主人，任务出错了，用时2分钟」 |
| `excerpt` | 「主人，任务完成了：修复了登录超时问题」（本轮助手回复的清洗摘录） |
| `llm`（默认） | 「主人，任务完成了。修复了登录超时并补了测试」（小 LLM 调用压缩本轮结果，失败逐级回退 excerpt→template→fixed） |

## 阻塞提醒（agent 在等你）

`reason=blocked`（agent 停下等确认/审批）走**紧急通道**：

- 豁免时长门槛（短轮也播）与冷却（`blockedBypassCooldown`）
- 静音时段行为由 `blockedQuietPolicy` 决定：
  - `local`（默认）：临时把系统输出切到本机扬声器 → `say` → 切回音箱（夜里也不吵音箱、但你能听到）
  - `speaker`：照常音箱播报
  - `skip`：静音期直接跳过
- 文案模板：`templates.blocked` =「主人，我在等你确认，请回来处理」

## 免打扰

| 机制 | 配置 | 说明 |
| --- | --- | --- |
| 短轮次静默 | `minDurationMs: 60000` | 运行不足 1 分钟的轮次不播（blocked 豁免） |
| 静音时段 | `quietHours: ["01:00","07:00"]` | 时段内不播出声，进入过夜摘要队列；支持跨零点 |
| 播报冷却 | `cooldownMs: 90000` | 两次播报间隔小于 90 秒时跳过（blocked 豁免） |
| goal 续跑感知 | `goalAware: true` + `goalDebounceMs: 90000` | goal 自动续跑不逐轮播；90 秒内无新轮次（= 整个目标完成）才播一次 |

## 过夜摘要

静音时段（01:00–07:00）的播报不丢弃，入队持久化（`digest-queue.json`），**07:00 整汇总播一次**：

- `llm` 模式：把整晚条目交给一次 LLM 调用合并成一段话——「主人，早上好。夜里完成了3个任务，其中1个出错」
- 其他模式：按条数与错误数生成摘要
- 进程重启不丢：重启后队列非空且已出静音时段 → 10 秒后补播

## GUI 设置面板（Web 客户端插件）

侧栏底部「🔊 语音播报」入口，状态点颜色：**绿**=就绪 / **灰**=静音时段 / **红**=上次失败 / **黄**=播报中。

点击打开面板：开关、播报模式、音量、静音时段、冷却、最短轮时长、阻塞提醒策略、过夜摘要开关，以及「🔈 试听」按钮。保存走 `POST /plugin-api/voice-info/config`，**即时生效免重启**（仅 keepAlive 相关需重启）。

## 可靠性

- **快速失败**（`speakerRetries: 1`）：音箱不可达/休眠时一次尝试即失败，立即降级本机播放——不会为重试空等一分多钟
- **迟到通知取消**（`cancelOnNewTurn: true`）：用户新开一轮时自动取消未播/播报中的旧通知（你已在电脑前，迟到的"任务完成"只剩困惑）；过夜摘要被取消会重新入队
- **本机回退**（`fallbackLocal`）：音箱播报失败时自动降级 `ble-speaker play` → `say`
- **连接保活**（`keepAlive`，默认关）：定期静默重连防音箱休眠
- **自检路由**：`http://127.0.0.1:3080/plugin-api/voice-info/test`（状态/配置/日志），`?announce=1` 试听
- **配置路由**：`GET/POST /plugin-api/voice-info/config`（白名单校验、持久化、即时生效）

## 其他行为

- 只监听**主对话**（子代理会话已过滤）
- 播报串行化 + 合并：不重叠、不抢占连接
- 完全旁路（不阻塞回合收尾），失败只记日志 `/tmp/dsh-voice-info.log`

## 配置

完整配置项及说明见 [`config.example.json`](config.example.json)（每项都有 `_comment`）。克隆后复制为 `config.json` 并改 `bleSpeakerDir`/`device` 指向你的环境。改文件需重启 GUI；用 GUI 面板或 POST 路由即时生效。

## 安装

前置：本机已有 ble-speaker 项目（macOS 需 `brew install blueutil switchaudio-osx`），且目标音箱成功连接过一次（写入其 `devices.json` 登记簿）。

```bash
git clone https://github.com/flyingtimes/dsh-voice-info.git ~/code/dsh-voice-info
cd ~/code/dsh-voice-info
cp config.example.json config.json   # 改 bleSpeakerDir / device
dsh plugin --profile web add ~/code/dsh-voice-info
```

包声明 `dsh.bundle.patch`（服务端）+ `dsh.client`（Web 客户端），重启 `dsh web` 后侧栏出现「🔊 语音播报」入口。

## 依赖

ble-speaker 侧需就绪：`blueutil`、`switchaudio-osx`（brew），设备成功连接过一次。`llm` 模式需要 profile 里有可用模型路由（缺失时自动回退）。
