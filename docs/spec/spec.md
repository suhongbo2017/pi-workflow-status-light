# Spec: Pi 工作流状态 → AI 红绿灯 LED 反馈

## Problem Statement

用户在使用 Pi 进行 AI 编码时，需要一种直观的物理方式感知 Pi 的工作状态。当前 Pi 的状态（是否在思考、是否已完成、是否出错）只能通过终端文本观察，缺少物理世界的即时反馈。用户已有一台 ESP32-S3 驱动的 AI 红绿灯（3 色彩色 LED），它通过 MQTT 接收工作流状态并显示对应的颜色/效果。

需要将 Pi 的运行状态实时反映到这台物理 LED 设备上。

## Solution

开发一个 Pi 扩展（TypeScript），监听 Pi 的生命周期事件，将 Pi 的状态映射为 MQTT 消息发布到 `ai/status` topic，AI 红绿灯设备接收后自动显示对应效果。

状态映射：

| Pi 事件 | 状态 | LED 效果 | 说明 |
|---------|------|---------|------|
| 扩展加载完成 | init | 紫色呼吸 | Pi 启动中 |
| 会话开始 / 空闲 | idle | 蓝色常亮 | 等待用户输入 |
| 用户提交提示词，AI 开始处理 | running | 黄色跑马灯 | AI 正在工作 |
| AI 完成所有处理（`agent_settled`） | done | 绿色常亮 | 任务完成，3秒后→idle |
| 工具执行出错 | error | 红色常亮 | 出错，3秒后→idle |
| 会话关闭 | idle | 蓝色常亮 | 会话结束 |

## User Stories

1. 作为用户，当我启动 Pi 时，我希望 LED 显示紫色呼吸，以便知道 Pi 正在初始化
2. 作为用户，当 Pi 等待我输入时，我希望 LED 显示蓝色常亮，以便知道系统就绪
3. 作为用户，当我提交问题给 Pi 后，我希望 LED 显示黄色闪烁，以便直观知道 AI 正在处理中
4. 作为用户，当 Pi 完成回答后，我希望 LED 显示绿色常亮，以便知道任务完成
5. 作为用户，当 Pi 执行工具出错时，我希望 LED 显示红色常亮，以便快速感知问题
6. 作为用户，当我关闭 Pi 时，我希望 LED 回到空闲状态，以便灯与系统状态一致
7. 作为用户，如果同时打开多个 Pi 窗口，我希望最后一个操作的状态优先显示在 LED 上

## Implementation Decisions

1. 使用 **Pi 扩展**（TypeScript）实现，放在 `~/.pi/agent/extensions/ai-traffic-light/` 下自动加载
2. 使用 npm 包 `mqtt` 连接 MQTT broker（broker.emqx.io:1883）
3. 事件监听：
   - `session_start` → 发 idle
   - `agent_start` → 发 running
   - `agent_settled` → 发 done → 3s 后 → idle（使用 agent_settled 而非 agent_end，因为 Pi 可能在 agent_end 后 auto-retry）
   - `tool_result`（isError=true）→ 发 error → 3s 后 → idle
   - `session_shutdown` → 发 idle + 关闭 MQTT 连接
4. 消息格式：JSON `{"state":"running", "message":"AI 处理中"}`
5. 使用 Retained 消息，新设备启动后自动收到最后状态
6. Client ID 动态生成（`pi-agent-{random}`），避免冲突
7. 不依赖硬件代码，只通过 MQTT 通信——与硬件解耦
8. 初始连接失败时 5 秒后重试一次

## Testing Decisions

1. 测试 seam：MQTT broker 本身。通过已有的 `test_mqtt_subscribe.py` 观察消息是否到达
2. 测试方法：在 Pi 中正常使用，观察 LED 灯是否按预期切换
3. 手动测试：使用 `test_mqtt_subscribe.py` 订阅 ai/status，验证消息序列
4. 覆盖场景：
   - 启动 Pi → 观察 init → idle
   - 提问 → 观察 running → done → idle
   - 触发错误（如让 Pi 执行不存在的命令）→ 观察 error → idle

## Out of Scope

1. **不**修改 ESP32-S3 硬件固件——硬件已开发完成，所有状态映射已就绪
2. **不**处理 Pi 的模型切换、compact 等内部状态——这些对用户来说不反映在 LED 上
3. **不**支持 Pi 的 RPC 模式——仅面向交互式使用场景
4. **不**提供 Web UI 或其他控制面板——只通过 MQTT 通信

## Further Notes

- 依赖的 `mqtt` npm 包需要在扩展目录下 `npm install`
- 自动发现路径：`~/.pi/agent/extensions/` 下的扩展 pi 会自动加载
- 已有原型代码可用，在此基础上打磨