/**
 * AI 红绿灯 — Pi 工作流状态反馈扩展
 *
 * 将 Pi 的运行状态实时映射到 AI 红绿灯 LED 上，通过 MQTT 发布状态消息。
 * 同时发布到 ai/status 和 ai/led/command，确保硬件可靠响应。
 *
 * 状态映射:
 *   init       → 紫色呼吸  (Pi 启动)
 *   idle       → 蓝色常亮  (等待用户输入)
 *   running    → 黄色跑马灯 (AI 正在处理中)
 *   done       → 绿色常亮  (任务完成，3秒后→idle)
 *   error      → 红色常亮  (工具执行出错，3秒后恢复前一个状态)
 *
 * 架构说明:
 *   - MQTT 连接全局唯一，不随 session 销毁/重建
 *   - 仅 factory 层负责连接管理，所有事件 handler 只消费状态
 *   - 使用 mqtts:// 而非 mqtt://（TLS），减少公共 broker 限流风险
 *   - clean=false 保持 session，避免 broker 强制断开
 *
 * 硬件: ESP32-S3 + 3x WS2812B (已实现所有状态效果)
 * MQTT: broker.emqx.io:1883, topic: ai/status / ai/led/command
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ====== 配置常量 ======
const MQTT_BROKER = "broker.emqx.io";
const MQTT_PORT = 1883;
const TOPIC_STATUS = "ai/status";
const TOPIC_COMMAND = "ai/led/command";
const TEMP_STATE_DURATION_MS = 3000; // done/error 临时状态的持续时间
const AGENT_SETTLED_TIMEOUT_MS = 5000; // agent_settled 降级超时

// ====== 状态常量 ======
const STATES = {
  INIT: "init",
  IDLE: "idle",
  RUNNING: "running",
  DONE: "done",
  ERROR: "error",
} as const;

// 状态 → 直接命令映射（用于 ai/led/command 兜底）
const STATE_TO_COMMAND: Record<string, string> = {
  init: "breath:purple",
  idle: "blue",
  running: "chase:yellow",
  done: "green",
  error: "red",
};

// ====== 类型定义 ======
type MqttClient = any;

// ====== 全局状态 ======
let mqttClient: MqttClient | null = null;
let tempStateTimer: ReturnType<typeof setTimeout> | null = null;
let agentSettledTimer: ReturnType<typeof setTimeout> | null = null;
let isAgentRunning = false;
let lastState: string | null = null;

// ====== MQTT 连接管理 ======
// 全局唯一 MQTT 客户端，不随 session 销毁。仅 factory 初始化一次。
async function ensureMQTTConnection(): Promise<boolean> {
  if (mqttClient && mqttClient.connected) {
    return true;
  }

  // 已在尝试连接或已连接则跳过
  if (mqttClient) {
    console.warn("[AI红绿灯] MQTT 连接中，跳过重复请求");
    return false;
  }

  try {
    const mqtt = await import("mqtt");
    const clientId = `pi-agent-${Math.random().toString(16).slice(2, 10)}`;

    // 使用 mqtts:// 走 TLS，比纯 mqtt:// 更稳定（公共 broker 限速策略不同）
    const url = `mqtts://${MQTT_BROKER}:${MQTT_PORT}`;

    mqttClient = mqtt.connect(url, {
      clientId,
      cleanSession: false,       // 保持 session
      keepalive: 60,
      reconnectPeriod: 10000,     // 后台自动重连（每 10s 试一次）
      connectTimeout: 10000,      // 首次连接 10s 超时
      protocolVersion: 4,         // MQTT 3.1.1
    });

    // connect 事件：由 mqtt.js 库在真正连通时触发
    mqttClient.on("connect", () => {
      console.log("[AI红绿灯] MQTT 已连接 (broker.emqx.io)");
    });

    mqttClient.on("error", (err: Error) => {
      console.error("[AI红绿灯] MQTT 错误:", err.message);
    });

    mqttClient.on("close", () => {
      console.log("[AI红绿灯] MQTT 连接已关闭，等待自动重连...");
    });

    mqttClient.on("reconnect", () => {
      console.log("[AI红绿灯] MQTT 正在重连...");
    });

    return true;
  } catch (e) {
    console.error("[AI红绿灯] 无法加载 mqtt 模块:", e);
    mqttClient = null;
    return false;
  }
}

// ====== 发布函数 ======

/**
 * 发布状态消息到 ai/status (Retained)。
 * 同时发布到 ai/led/command 作为兜底。
 */
function publishState(state: string, message?: string): void {
  if (!mqttClient || !mqttClient.connected) {
    console.warn(`[AI红绿灯] MQTT 未连接，跳过 ${state}（将自动重连后补发）`);
    return;
  }

  lastState = state;

  // 1. 发布到 ai/status (JSON 状态消息)
  const statusPayload = JSON.stringify({ state, ...(message ? { message } : {}) });
  mqttClient.publish(TOPIC_STATUS, statusPayload, { qos: 1, retain: true }, (err: Error | null) => {
    if (err) console.error(`[AI红绿灯] 发布 ${state} 到 ${TOPIC_STATUS} 失败:`, err.message);
  });

  // 2. 兜底：发布到 ai/led/command (直接控制命令)
  const command = STATE_TO_COMMAND[state];
  if (command) {
    mqttClient.publish(TOPIC_COMMAND, command, { qos: 1 }, (err: Error | null) => {
      if (err) console.error(`[AI红绿灯] 发布 ${command} 到 ${TOPIC_COMMAND} 失败:`, err.message);
    });
  }

  console.log(`[AI红绿灯] → ${state}${message ? ` (${message})` : ""} [cmd: ${command || "无"}]`);
}

/**
 * 设置一个临时状态，duration 毫秒后恢复。
 * 如果 agent 还在运行，恢复为 running；否则恢复为 idle。
 */
function setTempState(state: string, message: string, durationMs: number): void {
  // 清除之前的定时器
  if (tempStateTimer) {
    clearTimeout(tempStateTimer);
    tempStateTimer = null;
  }

  publishState(state, message);

  // 定时恢复
  tempStateTimer = setTimeout(() => {
    tempStateTimer = null;
    if (isAgentRunning) {
      publishState(STATES.RUNNING, "AI 继续处理");
    } else {
      publishState(STATES.IDLE, "等待任务");
    }
  }, durationMs);
}

/**
 * 清除所有定时器，重置状态。
 */
function clearAllTimers(): void {
  if (tempStateTimer) {
    clearTimeout(tempStateTimer);
    tempStateTimer = null;
  }
  if (agentSettledTimer) {
    clearTimeout(agentSettledTimer);
    agentSettledTimer = null;
  }
}

// ====== 扩展入口 ======
export default async function (pi: ExtensionAPI) {
  // === factory 层：确保全局 MQTT 连接（不随 session 销毁） ===
  await ensureMQTTConnection();
  
  // 首次加载 → 初始化（紫色呼吸）
  publishState(STATES.INIT, "Pi 启动中");

  // === 事件监听层：只消费状态，不动连接 ===

  // 会话开始 → 空闲（蓝色常亮）
  pi.on("session_start", async () => {
    publishState(STATES.IDLE, "等待任务");
  });

  // 用户提交提示词，AI 开始处理 → 运行中（黄色跑马灯）
  pi.on("agent_start", async () => {
    isAgentRunning = true;
    clearAllTimers();
    publishState(STATES.RUNNING, "AI 处理中");
  });

  // agent_end — 启动降级定时器
  //   如果 5 秒内 agent_settled 没触发，降级为 DONE
  pi.on("agent_end", async () => {
    console.log("[AI红绿灯] agent_end 触发，启动降级定时器");

    // 清除之前的降级定时器（防止重复 agent_end 重置）
    if (agentSettledTimer) {
      clearTimeout(agentSettledTimer);
      agentSettledTimer = null;
    }

    // 启动 5 秒降级定时器
    agentSettledTimer = setTimeout(() => {
      agentSettledTimer = null;
      console.log("[AI红绿灯] agent_settled 超时（5s），降级为 DONE");
      isAgentRunning = false;
      setTempState(STATES.DONE, "任务完成（降级）", TEMP_STATE_DURATION_MS);
    }, AGENT_SETTLED_TIMEOUT_MS);
  });

  // agent_settled — Pi 不会再自动继续 → 完成（绿色常亮，3秒后→idle）
  pi.on("agent_settled", async () => {
    console.log("[AI红绿灯] agent_settled 触发 — 所有处理完成");

    // 取消降级定时器
    if (agentSettledTimer) {
      clearTimeout(agentSettledTimer);
      agentSettledTimer = null;
    }

    isAgentRunning = false;
    setTempState(STATES.DONE, "任务完成", TEMP_STATE_DURATION_MS);
  });

  // 工具执行出错 → 错误（红色常亮，3秒后恢复）
  pi.on("tool_result", async (event) => {
    if (event.isError) {
      console.log("[AI红绿灯] 工具执行出错");
      setTempState(STATES.ERROR, "工具执行出错", TEMP_STATE_DURATION_MS);
    }
  });

  // 会话关闭 → 仅清理状态，不断开 MQTT
  pi.on("session_shutdown", async () => {
    isAgentRunning = false;
    clearAllTimers();
    // 【不再】调用 mqttClient.end() —— 全局连接要保持！
    // 下个 session 启动时会通过 session_start → publishState(IDLE) 覆盖
  });

  // 兜底：每 30 秒检查是否卡在 running 状态
  setInterval(() => {
    if (mqttClient && mqttClient.connected && lastState === STATES.RUNNING && !isAgentRunning) {
      console.log("[AI红绿灯] 兜底检测：卡在 running 但 agent 已结束，恢复 idle");
      publishState(STATES.IDLE, "等待任务（兜底恢复）");
    }
  }, 30000);
}
