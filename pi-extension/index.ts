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
 * 事件说明:
 *   agent_end  → 启动 5s 降级定时器，不直接切换 LED
 *   agent_settled → 取消降级定时器，切换 DONE（Pi 不会再自动继续）
 *   5s 超时   → 如果 agent_settled 未触发，降级使用 agent_end
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
const MQTT_CONNECT_TIMEOUT_MS = 8000; // MQTT 连接超时
const MQTT_RECONNECT_DELAY_MS = 3000; // 首次连接失败后重试延迟
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
/** 当 MQTT 未连接时，暂存待发布的状态 */
let pendingState: { state: string; message?: string } | null = null;

// ====== MQTT 工具函数 ======

/**
 * 连接到 MQTT broker。
 * 返回客户端实例，若失败则返回 null。
 */
async function connectMQTT(): Promise<MqttClient | null> {
  try {
    const mqtt = await import("mqtt");
    const clientId = "pi-agent-" + Math.random().toString(16).slice(2, 10);
    const client = mqtt.connect(`mqtt://${MQTT_BROKER}:${MQTT_PORT}`, {
      clientId,
      clean: true,
      connectTimeout: MQTT_CONNECT_TIMEOUT_MS,
      keepalive: 30,
      reconnectPeriod: MQTT_RECONNECT_DELAY_MS,
    });

    return new Promise((resolve) => {
      client.on("connect", () => {
        console.log("[AI红绿灯] MQTT 已连接");
        // 连接成功后，刷新暂存状态
        flushPendingState();
        resolve(client);
      });
      client.on("error", (err: Error) => {
        console.error("[AI红绿灯] MQTT 错误:", err.message);
      });
      client.on("close", () => {
        console.log("[AI红绿灯] MQTT 连接已关闭");
      });
      client.on("reconnect", () => {
        console.log("[AI红绿灯] MQTT 正在重连...");
      });
      setTimeout(() => {
        if (client.connected) return;
        console.warn(`[AI红绿灯] MQTT 连接超时 (${MQTT_CONNECT_TIMEOUT_MS}ms)`);
        client.end(true);
        resolve(null);
      }, MQTT_CONNECT_TIMEOUT_MS);
    });
  } catch (e) {
    console.error("[AI红绿灯] 无法加载 mqtt 模块:", e);
    return null;
  }
}

/**
 * 发布状态消息到 ai/status (Retained)。
 * 同时发布到 ai/led/command 作为兜底。
 * 如果 MQTT 未连接，暂存到 pendingState 队列中，等连接后自动刷新。
 */
function publishState(state: string, message?: string): void {
  if (!mqttClient || !mqttClient.connected) {
    // 暂存，等 MQTT 连接后自动刷新
    pendingState = { state, message };
    console.warn(`[AI红绿灯] MQTT 未连接，暂存状态: ${state}`);
    return;
  }

  lastState = state;
  pendingState = null; // 已成功发布，清除暂存

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
 * 刷新暂存状态。
 * 如果 MQTT 已连接且存在 pendingState，立即发布。
 */
function flushPendingState(): void {
  if (pendingState && mqttClient && mqttClient.connected) {
    const { state, message } = pendingState;
    pendingState = null;
    console.log(`[AI红绿灯] 刷新暂存状态: ${state}`);
    publishState(state, message);
  }
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
  // 1. 连接 MQTT（首次连接，超时后会降级走重试逻辑）
  mqttClient = await connectMQTT();

  // 如果首次连接失败，延迟后重试一次
  if (!mqttClient) {
    setTimeout(async () => {
      mqttClient = await connectMQTT();
      // 重连成功后，pendingState 会在 connect 回调中通过 flushPendingState 刷新
    }, MQTT_RECONNECT_DELAY_MS);
  }

  // 2. 扩展加载完成 → 初始化（紫色呼吸），如果 MQTT 未连接会暂存
  publishState(STATES.INIT, "Pi 启动中");

  // 3. 会话开始 → 空闲（蓝色常亮）
  pi.on("session_start", async () => {
    publishState(STATES.IDLE, "等待任务");
  });

  // 4. 用户提交提示词，AI 开始处理 → 运行中（黄色跑马灯）
  pi.on("agent_start", async () => {
    isAgentRunning = true;
    clearAllTimers();
    publishState(STATES.RUNNING, "AI 处理中");
  });

  // 5. agent_end — 启动降级定时器
  //    如果 5 秒内 agent_settled 没触发，降级为 DONE
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

  // 6. agent_settled — Pi 不会再自动继续 → 完成（绿色常亮，3秒后→idle）
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

  // 7. 工具执行出错 → 错误（红色常亮，3秒后恢复）
  pi.on("tool_result", async (event) => {
    if (event.isError) {
      console.log("[AI红绿灯] 工具执行出错");
      setTempState(STATES.ERROR, "工具执行出错", TEMP_STATE_DURATION_MS);
    }
  });

  // 8. 会话关闭 → 空闲 + 清理 MQTT 连接
  pi.on("session_shutdown", async () => {
    isAgentRunning = false;
    clearAllTimers();
    pendingState = null;
    publishState(STATES.IDLE, "会话结束");

    // 关闭 MQTT 连接（graceful，不 force）
    if (mqttClient) {
      if (mqttClient.connected) {
        mqttClient.end(false); // graceful close
      }
      mqttClient = null;
    }
  });

  // 9. 兜底：每 30 秒检查是否卡在 running 状态
  setInterval(() => {
    if (mqttClient && mqttClient.connected && lastState === STATES.RUNNING && !isAgentRunning) {
      console.log("[AI红绿灯] 兜底检测：卡在 running 但 agent 已结束，恢复 idle");
      publishState(STATES.IDLE, "等待任务（兜底恢复）");
    }
  }, 30000);
}