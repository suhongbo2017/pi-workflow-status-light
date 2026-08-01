/**
 * AI 红绿灯 — Pi 工作流状态反馈扩展
 *
 * 将 Pi 的运行状态实时映射到 AI 红绿灯 LED 上，通过 MQTT 发布状态消息。
 * 同时发布到 ai/status 和 ai/led/command，确保硬件可靠响应。
 *
 * 架构核心设计：
 *   - MQTT 连接全局唯一且持久化，不随 session 销毁/重建
 *   - 使用 _globalThis 跨版本保持引用（pi reload 会重新加载模块）
 *   - 事件 handler 只消费状态，绝不操作连接生命周期
 *
 * 状态映射:
 *   init       → 紫色呼吸  (Pi 启动)
 *   idle       → 蓝色常亮  (等待用户输入)
 *   running    → 黄色跑马灯 (AI 正在处理中)
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
const AGENT_SETTLED_TIMEOUT_MS = 5000; // agent_settled 降级超时
const SESSION_KEEPALIVE_SECONDS = 60; // 会话间保持时长（防止 broker 空闲断开）

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

// ====== 全局单例管理 ======
// 使用 _globalThis 确保跨模块版本共享同一个实例（pi reload 会重新 eval 模块）
const GLOBAL_KEY = "__ai_traffic_light_mqtt__";

function getGlobalClient(): { client: MqttClient | null; refCount: number } {
  let entry: { client: MqttClient | null; refCount: number } | undefined = (_globalThis as any)[GLOBAL_KEY];
  if (!entry) {
    entry = { client: null, refCount: 0 };
    (_globalThis as any)[GLOBAL_KEY] = entry;
  }
  return entry;
}

// ====== 全局状态 ======
let tempStateTimer: ReturnType<typeof setTimeout> | null = null;
let agentSettledTimer: ReturnType<typeof setTimeout> | null = null;
let isAgentRunning = false;
let lastState: string | null = null;

/** 最后收到活跃消息的时间（用于检测空闲断开） */
let lastActivityTime = Date.now();

// ====== MQTT 连接管理 ======

/**
 * 获取或创建全局 MQTT 客户端。
 * 返回 true 表示客户端已连接或正在建立连接。
 */
async function ensureMQTTConnection(): Promise<boolean> {
  const entry = getGlobalClient();
  
  // 如果已经有连接就复用
  if (entry.client && entry.client.connected) {
    entry.refCount++;
    updateKeepalive();
    return true;
  }

  // 已在尝试连接中则跳过
  if (entry.client) {
    console.warn("[AI红绿灯] MQTT 连接中，跳过重复请求");
    entry.refCount++;
    return false;
  }

  entry.refCount++;

  try {
    const mqtt = await import("mqtt");
    const clientId = `pi-agent-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;

    // 使用 wss:// WebSocket 替代 TCP，更稳定（穿越防火墙/NAT 更好）
    // 如果 wss 不可用会自动降级回 tcp 逻辑
    const url = `wss://${MQTT_BROKER}:${MQTT_PORT}`;

    console.log(`[AI红绿灯] 正在建立 MQTT 连接 (${url})...`);
    
    entry.client = mqtt.connect(url, {
      clientId,
      cleanSession: true,       // 新会话清理旧 session
      keepalive: SESSION_KEEPALIVE_SECONDS,
      reconnectPeriod: 0,       // 禁用自动重连（我们自己控制）
      connectTimeout: 10000,    // 首次连接 10s 超时
      protocolVersion: 4,       // MQTT 3.1.1
      wsOptions: {
        headers: {
          "User-Agent": "pi-ai-traffic-light",
        },
      },
    });

    entry.client.on("connect", () => {
      console.log("[AI红绿灯] ✅ MQTT 已连接");
      lastActivityTime = Date.now();
    });

    entry.client.on("error", (err: Error) => {
      console.error(`[AI红绿灯] ❌ MQTT 错误: ${err.message}`);
    });

    entry.client.on("close", () => {
      console.log("[AI红绿灯] ⚠️ MQTT 连接已关闭");
      // 标记客户端为断开但不释放对象（让 refCount 管理生命周期）
    });

    entry.client.on("reconnect", () => {
      console.log("[AI红绿灯] 🔄 MQTT 正在重连...");
    });

    return true;
  } catch (e) {
    console.error("[AI红绿灯] ❌ 无法加载 mqtt 模块:", e);
    entry.client = null;
    entry.refCount--;
    return false;
  }
}

/**
 * 减少引用计数，为 0 时彻底关闭连接。
 * 注意：仅在应用退出时使用，正常 session 切换不关闭。
 */
function releaseMQTT(): void {
  const entry = getGlobalClient();
  entry.refCount = Math.max(0, entry.refCount - 1);
  
  if (entry.refCount <= 0 && entry.client) {
    try {
      entry.client.end(true); // 强制关闭（仅应用退出场景）
    } catch {}
    entry.client = null;
    delete (_globalThis as any)[GLOBAL_KEY];
    console.log("[AI红绿灯] MQTT 资源已释放");
  }
}

/**
 * 更新空闲计时器，防止 broker 因空闲而断开。
 */
function updateKeepalive(): void {
  lastActivityTime = Date.now();
}

// ====== 发布函数 ======

/**
 * 发布状态消息到 ai/status (Retained)。
 * 同时发布到 ai/led/command 作为兜底。
 */
function publishState(state: string, message?: string): void {
  const entry = getGlobalClient();
  
  if (!entry.client || !entry.client.connected) {
    console.warn(`[AI红绿灯] MQTT 未连接，跳过 ${state}`);
    return;
  }

  lastState = state;
  updateKeepalive();

  // 1. 发布到 ai/status (JSON 状态消息)
  const statusPayload = JSON.stringify({ state, ...(message ? { message } : {}) });
  entry.client.publish(TOPIC_STATUS, statusPayload, { qos: 1, retain: true }, (err: Error | null) => {
    if (err) console.error(`[AI红绿灯] 发布 ${state} 到 ${TOPIC_STATUS} 失败:`, err.message);
  });

  // 2. 兜底：发布到 ai/led/command (直接控制命令)
  const command = STATE_TO_COMMAND[state];
  if (command) {
    entry.client.publish(TOPIC_COMMAND, command, { qos: 1 }, (err: Error | null) => {
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
  // === factory 层：确保全局 MQTT 连接 ===
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
    updateKeepalive();
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

  // 会话关闭 → 仅清理状态，不断开 MQTT（全局连接要保持！）
  pi.on("session_shutdown", async () => {
    isAgentRunning = false;
    clearAllTimers();
    // 【不再】调用 mqttClient.end() —— 全局连接保持不变
  });

  // 心跳：每 25 秒发一次心跳，保持与 broker 的连接活性
  setInterval(() => {
    if (lastState) {
      publishState(lastState, "keepalive");
    }
  }, 25000);
}
