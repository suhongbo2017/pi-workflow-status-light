/**
 * AI 红绿灯 — Pi 工作流状态反馈扩展
 *
 * 将 Pi 的运行状态实时映射到 AI 红绿灯 LED 上，通过 MQTT 发布状态消息。
 * 同时发布到 ai/status 和 ai/led/command，确保硬件可靠响应。
 *
 * 状态映射:
 *   init       → 紫色呼吸  (Pi 启动)
 *   idle       → 蓝色常亮  (等待用户输入)
 *   running    → 黄色闪烁  (AI 正在处理中)
 *   done       → 绿色常亮  (任务完成，3秒后→idle)
 *   error      → 红色常亮  (工具执行出错，3秒后恢复前一个状态)
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
const RECONNECT_INTERVAL_MS = 5000; // MQTT 重连间隔

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
let isAgentRunning = false;
let lastState: string | null = null; // 记录最后发布的状态

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
      connectTimeout: 5000,
      keepalive: 30,
      reconnectPeriod: RECONNECT_INTERVAL_MS,
    });

    return new Promise((resolve) => {
      client.on("connect", () => {
        console.log("[AI红绿灯] MQTT 已连接");
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
        console.warn("[AI红绿灯] MQTT 连接超时");
        client.end(true);
        resolve(null);
      }, 5000);
    });
  } catch (e) {
    console.error("[AI红绿灯] 无法加载 mqtt 模块:", e);
    return null;
  }
}

/**
 * 发布状态消息到 ai/status (Retained)。
 * 同时发布到 ai/led/command 作为兜底。
 */
function publishState(state: string, message?: string): void {
  if (!mqttClient || !mqttClient.connected) {
    console.warn(`[AI红绿灯] MQTT 未连接，无法发布 ${state}`);
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

// ====== 扩展入口 ======
export default async function (pi: ExtensionAPI) {
  // 1. 连接 MQTT
  mqttClient = await connectMQTT();

  // 如果首次连接失败，5 秒后重试一次
  if (!mqttClient) {
    setTimeout(async () => {
      mqttClient = await connectMQTT();
      if (mqttClient) {
        publishState(STATES.IDLE, "等待任务");
      }
    }, RECONNECT_INTERVAL_MS);
  }

  // 2. 扩展加载完成 → 初始化（紫色呼吸）
  publishState(STATES.INIT, "Pi 启动中");

  // 3. 会话开始 → 空闲（蓝色常亮）
  pi.on("session_start", async () => {
    publishState(STATES.IDLE, "等待任务");
  });

  // 4. 用户提交提示词，AI 开始处理 → 运行中（黄色闪烁）
  pi.on("agent_start", async () => {
    isAgentRunning = true;
    // 如果正在显示临时状态，清除定时器
    if (tempStateTimer) {
      clearTimeout(tempStateTimer);
      tempStateTimer = null;
    }
    publishState(STATES.RUNNING, "AI 处理中");
  });

  // 5. AI 完成所有处理 → 完成（绿色常亮，3秒后→idle）
  pi.on("agent_end", async () => {
    console.log("[AI红绿灯] agent_end 触发");
    isAgentRunning = false;
    setTempState(STATES.DONE, "任务完成", TEMP_STATE_DURATION_MS);
  });

  // 6. 工具执行出错 → 错误（红色常亮，3秒后恢复）
  pi.on("tool_result", async (event) => {
    if (event.isError) {
      console.log("[AI红绿灯] 工具执行出错");
      setTempState(STATES.ERROR, "工具执行出错", TEMP_STATE_DURATION_MS);
    }
  });

  // 7. 会话关闭 → 空闲 + 清理 MQTT 连接
  pi.on("session_shutdown", async () => {
    isAgentRunning = false;
    if (tempStateTimer) {
      clearTimeout(tempStateTimer);
      tempStateTimer = null;
    }
    publishState(STATES.IDLE, "会话结束");

    // 关闭 MQTT 连接
    if (mqttClient && mqttClient.connected) {
      mqttClient.end(true);
      mqttClient = null;
    }
  });

  // 8. 兜底：每 30 秒检查是否卡在 running 状态
  // 如果上一次 agent_end 没触发，手动恢复
  setInterval(() => {
    if (mqttClient && mqttClient.connected && lastState === STATES.RUNNING && !isAgentRunning) {
      console.log("[AI红绿灯] 兜底检测：卡在 running 但 agent 已结束，恢复 idle");
      publishState(STATES.IDLE, "等待任务（兜底恢复）");
    }
  }, 30000);
}