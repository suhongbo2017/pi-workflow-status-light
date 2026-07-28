# 01 — 核心 MQTT 事件映射

**What to build:** Pi 扩展建立 MQTT 连接，监听 Pi 的生命周期事件并映射为 LED 状态消息。
状态覆盖：init（扩展加载）→ idle（会话开始）→ running（agent_start）→ done（agent_end，3秒后→idle）。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 扩展目录结构：`~/.pi/agent/extensions/ai-traffic-light/` 含 `package.json` + `index.ts`
- [ ] `mqtt` npm 依赖已安装
- [ ] 扩展加载时连接 MQTT broker（broker.emqx.io:1883）
- [ ] 连接失败时 5 秒后自动重试一次
- [ ] 扩展加载 → 发 `{"state":"init", "message":"Pi 启动中"}`
- [ ] `session_start` → 发 `{"state":"idle", "message":"等待任务"}`
- [ ] `agent_start` → 发 `{"state":"running", "message":"AI 处理中"}`
- [ ] `agent_end` → 发 `{"state":"done", "message":"任务完成"}`
- [ ] done 状态 3 秒后自动恢复为 idle
- [ ] 消息使用 Retained 标志（QoS 1, retain: true）
- [ ] 手动验证：`test_mqtt_subscribe.py` 可观察到正确的消息序列