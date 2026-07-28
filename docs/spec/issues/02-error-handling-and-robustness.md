# 02 — 错误检测与健壮性

**What to build:** 在核心事件映射基础上，增加工具执行错误检测、会话关闭清理和连接健壮性。

**Blocked by:** 01 — Core MQTT event mapping

**Status:** ready-for-agent

- [ ] 监听 `tool_result` 事件，当 `isError === true` 时发 `error` 状态
- [ ] error 状态 3 秒后自动恢复为 idle（如果正在 running 则恢复 running）
- [ ] `session_shutdown` 时发 `{"state":"idle", "message":"会话结束"}` 并关闭 MQTT 连接
- [ ] 多个 Pi 窗口同时运行时，最后一个操作的消息覆盖前面的（不冲突）
- [ ] 手动验证：让 Pi 执行一个失败的命令（如 `nonexistent_command`），观察 LED 变红
- [ ] 手动验证：关闭 Pi 窗口，观察 LED 回到空闲状态