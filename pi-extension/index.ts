/**
 * AI 红绿灯 — Pi 工作流状态反馈扩展
 *
 * 将 Pi 的运行状态实时映射到 AI 红绿灯 LED 上，通过 MQTT 发布状态消息。
 * 同时发布到 ai/status 和 ai/led/command，确保硬件可靠响应。
 *
 * 架构核心设计：
 *   - MQTT 连接全局唯一且持久化，不随 session 销毁/重建
 *   - 使用 _globalThis 跨模块版本共享同一个实例
 *   - 事件 handler 只消费状态，绝不操作连接生命周期
 *   - **并行工具错误去重**：同一轮内多个 tool_result(isError) 合并为一次红色闪烁
 *
 * 状态映射:
 *   init       → 紫色呼吸  (Pi 启动)
 *   idle       → 蓝色常亮  (等待用户输入)
 *   running    → 黄色跑马灯 (AI 正在处理中)
 *   done       → 绿色常亮  (任务完成，3秒后→idle)
 *   error      → 红色常亮  (工具执行出错)
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
const SESSION_KEEPALIVE_SECONDS = 60; // 会话间保持时长
const TOOL_ERROR_MIN_INTERVAL_MS = 5000; // 工具错误最小间隔（防止短时间内重复闪红）

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
const GLOBAL_KEY = "__ai_traffic_light_mqtt__";

interface GlobalMqttEntry {
  client: MqttClient | null;
  refCount: number;
  connectPromise: Promise<MqttClient | null> | null;
}

function getGlobalClient(): GlobalMqttEntry {
  let entry: GlobalMqttEntry | undefined = (_globalThis as any)[GLOBAL_KEY];
  if (!entry) {
    entry = { client: null, refCount: 0, connectPromise: null };
    (_globalThis as any)[GLOBAL_KEY] = entry;
  }
  return entry;
}

// ====== 全局状态 ======
let tempStateTimer: ReturnType<typeof setTimeout> | null = null;
let agentSettledTimer: ReturnType<typeof setTimeout> | null = null;
let isAgentRunning = false;
let lastState: string | null = null;

/** 工具错误去重计时器 —— 防止并行工具导致的多重错误闪红 */
let toolErrorMinTimer: ReturnType<typeof setTimeout> | null = null;
let toolErrorCooldownEnd = 0; // 冷却期结束时间戳

// ====== MQTT 连接管理 ======

async function ensureMQTTConnection(): Promise<boolean> {
  const entry = getGlobalClient();
  
  // 已有连接就复用
  if (entry.client && entry.client.connected) {
    entry.refCount++;
    return true;
  }

  // 避免并发建立连接的竞态：返回已有的 pending promise
  if (entry.connectPromise) {
    console.warn("[AI红绿灯] MQTT 连接中（并发保护），跳过");
    return false;
  }

  entry.connectPromise = _connectMQTT(entry);
  
  try {
    await entry.connectPromise;
  } finally {
    entry.connectPromise = null;
  }
  
  return entry.client != null && entry.client.connected;
}

async function _connectMQTT(entry: GlobalMqttEntry): Promise<MqttClient | null> {
  entry.refCount++;

  try {
    const mqtt = await import("mqtt");
    const clientId = `pi-agent-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;

    // 尝试 WebSocket 优先（更稳定），失败后用 tcp 降级
    let url = `mqtts://${MQTT_BROKER}:${MQTT_PORT}`;
    
    // 尝试先连接 WebSocket
    try {
      console.log(`[AI红绿灯] 正在建立 MQTT 连接 (${url})...`);
      
      entry.client = mqtt.connect(url, {
        clientId,
        cleanSession: true,
        keepalive: SESSION_KEEPALIVE_SECONDS,
        reconnectPeriod: 10000,
        connectTimeout: 10000,
        protocolVersion: 4,
      });

      return await new Promise<MqttClient | null>((resolve) => {
        entry.client!.on("connect", () => {
          console.log("[AI红绿灯] ✅ MQTT wss:// 已连接");
          resolve(entry.client!);
        });
        entry.client!.on("error", (err: Error) => {
          // 连接错误，尝试降级
          console.warn(`[AI红绿灯] wss:// 连接失败: ${err.message}，降级到 tcp://`);
          entry.client!.end(true);
          entry.client = null;
          resolve(null);
        });
        entry.client!.on("close", () => {});
        entry.client!.on("reconnect", () => {});
        
        // 10 秒超时
        setTimeout(() => {
          if (entry.client && entry.client.connected) return;
          console.warn("[AI红绿灯] wss:// 连接超时，降级到 tcp://");
          if (entry.client) entry.client.end(true);
          entry.client = null;
          resolve(null);
        }, 10000);
      });
    } catch (e) {
      console.warn(`[AI红绿灯] wss:// 连接异常: ${e}, 降级到 tcp://`);
      entry.client = null;
    }

    // 降级到 tcp
    url = `tcp://${MQTT_BROKER}:${MQTT_PORT}`;
    console.log(`[AI红绿灯] 正在建立 MQTT 连接 (降级: ${url})...`);
    
    entry.client = mqtt.connect(url, {
      clientId,
      cleanSession: true,
      keepalive: SESSION_KEEPALIVE_SECONDS,
      reconnectPeriod: 10000,
      connectTimeout: 10000,
      protocolVersion: 4,
    });

    return await new Promise<MqttClient | null>((resolve) => {
      entry.client!.on("connect", () => {
        console.log("[AI红绿灯] ✅ MQTT tcp:// 已连接");
        resolve(entry.client!);
      });
      entry.client!.on("error", (err: Error) => {
        console.error(`[AI红绿灯] ❌ MQTT tcp:// 错误: ${err.message}`);
      });
      entry.client!.on("close", () => {});
      entry.client!.on("reconnect", () => {});
      
      setTimeout(() => {
        if (entry.client && entry.client.connected) return;
        console.warn("[AI红绿灯] tcp:// 连接超时");
        if (entry.client) entry.client.end(true);
        entry.client = null;
        resolve(null);
      }, 10000);
    });
  } catch (e) {
    console.error("[AI红绿灯] ❌ 无法加载 mqtt 模块:", e);
    entry.client = null;
    entry.refCount--;
    return null;
  }
}

function releaseMQTT(): void {
  const entry = getGlobalClient();
  entry.refCount = Math.max(0, entry.refCount - 1);
  
  if (entry.refCount <= 0 && entry.client) {
    try { entry.client.end(true); } catch {}
    entry.client = null;
    delete (_globalThis as any)[GLOBAL_KEY];
    console.log("[AI红绿灯] MQTT 资源已释放");
  }
}

// ====== 发布函数 ======

function publishState(state: string, message?: string): void {
  const entry = getGlobalClient();
  
  if (!entry.client || !entry.client.connected) {
    console.warn(`[AI红绿灯] MQTT 未连接，跳过 ${state}`);
    return;
  }

  lastState = state;

  const statusPayload = JSON.stringify({ state, ...(message ? { message } : {}) });
  entry.client.publish(TOPIC_STATUS, statusPayload, { qos: 1, retain: true }, (err: Error | null) => {
    if (err) console.error(`[AI红绿灯] 发布 ${state} 到 ${TOPIC_STATUS} 失败:`, err.message);
  });

  const command = STATE_TO_COMMAND[state];
  if (command) {
    entry.client.publish(TOPIC_COMMAND, command, { qos: 1 }, (err: Error | null) => {
      if (err) console.error(`[AI红绿灯] 发布 ${command} 到 ${TOPIC_COMMAND} 失败:`, err.message);
    });
  }

  console.log(`[AI红绿灯] → ${state}${message ? ` (${message})` : ""} [cmd: ${command || "无"}]`);
}

// ====== 错误去重：工具错误冷却机制 ======

/**
 * 检查工具错误是否在冷却期内。
 * 如果在冷却期内则跳过显示（避免并行工具导致的多重闪红）。
 * @returns true 表示应该跳过本次错误
 */
function shouldSkipToolError(): boolean {
  const now = Date.now();
  if (now < toolErrorCooldownEnd) {
    console.log(`[AI红绿灯] ⏭️ 工具错误冷却中（${TOOL_ERROR_MIN_INTERVAL_MS}ms），跳过`);
    return true;
  }
  return false;
}

/**
 * 设置工具错误冷却期。
 */
function startToolErrorCooldown(): void {
  toolErrorCooldownEnd = Date.now() + TOOL_ERROR_MIN_INTERVAL_MS;
  if (toolErrorMinTimer) clearTimeout(toolErrorMinTimer);
  toolErrorMinTimer = setTimeout(() => {
    toolErrorMinTimer = null;
    toolErrorCooldownEnd = 0;
  }, TOOL_ERROR_MIN_INTERVAL_MS);
}

// ====== 辅助函数 ======

function setTempState(state: string, message: string, durationMs: number): void {
  if (tempStateTimer) {
    clearTimeout(tempStateTimer);
    tempStateTimer = null;
  }

  publishState(state, message);

  tempStateTimer = setTimeout(() => {
    tempStateTimer = null;
    if (isAgentRunning) {
      publishState(STATES.RUNNING, "AI 继续处理");
    } else {
      publishState(STATES.IDLE, "等待任务");
    }
  }, durationMs);
}

function clearAllTimers(): void {
  if (tempStateTimer) { clearTimeout(tempStateTimer); tempStateTimer = null; }
  if (agentSettledTimer) { clearTimeout(agentSettledTimer); agentSettledTimer = null; }
  if (toolErrorMinTimer) { clearTimeout(toolErrorMinTimer); toolErrorMinTimer = null; }
  toolErrorCooldownEnd = 0;
}

// ====== 扩展入口 ======
export default async function (pi: ExtensionAPI) {
  // === factory 层：确保全局 MQTT 连接 ===
  await ensureMQTTConnection();
  publishState(STATES.INIT, "Pi 启动中");

  // === 事件监听层 ===

  pi.on("session_start", async () => {
    publishState(STATES.IDLE, "等待任务");
  });

  pi.on("agent_start", async () => {
    isAgentRunning = true;
    clearAllTimers();
    publishState(STATES.RUNNING, "AI 处理中");
  });

  // agent_end — 启动降级定时器
  pi.on("agent_end", async () => {
    console.log("[AI红绿灯] agent_end 触发，启动降级定时器");
    if (agentSettledTimer) {
      clearTimeout(agentSettledTimer);
      agentSettledTimer = null;
    }
    agentSettledTimer = setTimeout(() => {
      agentSettledTimer = null;
      console.log("[AI红绿灯] agent_settled 超时（5s），降级为 DONE");
      isAgentRunning = false;
      setTempState(STATES.DONE, "任务完成（降级）", TEMP_STATE_DURATION_MS);
    }, AGENT_SETTLED_TIMEOUT_MS);
  });

  pi.on("agent_settled", async () => {
    console.log("[AI红绿灯] agent_settled 触发 — 所有处理完成");
    if (agentSettledTimer) {
      clearTimeout(agentSettledTimer);
      agentSettledTimer = null;
    }
    isAgentRunning = false;
    setTempState(STATES.DONE, "任务完成", TEMP_STATE_DURATION_MS);
  });

  // ============================================================
  // 工具执行出错 — 带冷却防抖
  // ============================================================
  // 当 pi 并行执行多个工具时，tool_result 会被多次触发。
  // 如果多个工具都出错，我们只在第一个上闪红灯，后续 5 秒内的
  // 同类错误自动跳过，避免 LED 疯狂闪红。
  // 但如果 agent 在冷却期间完成了本轮（agent_end 或 agent_settled），
  // 下一个新批次启动时冷却会被 clearAllTimers 清除。
  // ============================================================
  pi.on("tool_result", async (event) => {
    if (event.isError) {
      console.log(`[AI红绿灯] 工具执行出错: ${event.toolName || "unknown"}`);
      
      // 检查是否在冷却期内
      if (shouldSkipToolError()) {
        return;
      }
      
      startToolErrorCooldown();
      setTempState(STATES.ERROR, `工具出错: ${event.toolName || "unknown"}`, TEMP_STATE_DURATION_MS);
    }
  });

  // 会话关闭 → 不断开 MQTT
  pi.on("session_shutdown", async () => {
    isAgentRunning = false;
    clearAllTimers();
  });

  // 心跳保活
  setInterval(() => {
    if (lastState) {
      publishState(lastState, "keepalive");
    }
  }, 25000);
}
