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
 *   - **并行工具错误去重**：同一 agent_run 生命周期内仅首个错误闪红
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
  connectedPromise: Promise<boolean> | null;
}

function getGlobalEntry(): GlobalMqttEntry {
  let entry: GlobalMqttEntry | undefined = (_globalThis as any)[GLOBAL_KEY];
  if (!entry) {
    entry = { client: null, connectedPromise: null };
    (_globalThis as any)[GLOBAL_KEY] = entry;
  }
  return entry;
}

// ====== 全局运行时状态 ======
let stateTimer: ReturnType<typeof setTimeout> | null = null;
let settledTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

/** 是否处于 agent 运行周期中（agent_start → agent_end/settled/session_shutdown）*/
let isAgentRunning = false;

/** 最后一次发布的状态 */
let lastState: string | null = null;

/**
 * ─────────────────────────────────────────────────────
 * Bug 修复 #2 & #3 核心设计：agent_run 生命周期追踪
 * ─────────────────────────────────────────────────────
 * 而非简单的 time-based cooldown。
 *
 * 原理：
 *   每个 agent_run 是一个完整的工作单元（start → end）。
 *   在这个周期内可能有多个并行工具执行，产生多个 tool_result。
 *   我们只在第一个 tool_error 时闪红灯，同周期内后续错误静默记录。
 *   agent_run 结束后自动重置状态。
 *
 * 变量说明：
 *   hasReportedError    — 本轮 agent_run 是否已经报告过错误（闪过红灯）
 *   agentRunId          — 本轮 agent_run 的唯一标识（用于防止僵尸事件）
 */
let hasReportedError = false;     // 本轮是否已报告过错误
let agentRunId = 0;              // 每轮 agent_start 递增，用于识别过时事件
let reportedErrorTool = "";      // 首次报告的错误工具名

// ====== MQTT 连接管理 ======

async function ensureMQTTConnected(): Promise<void> {
  const entry = getGlobalEntry();

  // 已有连接就复用
  if (entry.client && entry.client.connected) {
    return;
  }

  // 避免并发建立连接的竞态
  if (entry.connectedPromise) {
    await entry.connectedPromise;
    return;
  }

  entry.connectedPromise = _doConnect(entry);

  try {
    await entry.connectedPromise;
  } finally {
    entry.connectedPromise = null;
  }
}

function _doConnect(entry: GlobalMqttEntry): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    (async () => {
      try {
        const mqtt = await import("mqtt");
        const clientId = `pi-led-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;

        // 优先尝试 wss:// WebSocket
        const wssUrl = `wss://${MQTT_BROKER}:${MQTT_PORT}`;
        console.log(`[AI红绿灯] 正在建立 MQTT 连接 (${wssUrl})...`);

        let client = mqtt.connect(wssUrl, {
          clientId,
          cleanSession: true,
          keepalive: 60,
          reconnectPeriod: 0,
          connectTimeout: 10000,
          protocolVersion: 4,
        });

        await new Promise<void>((res, rej) => {
          client.on("connect", () => {
            console.log("[AI红绿灯] ✅ MQTT wss:// 已连接");
            res();
          });
          client.on("error", () => {
            client.end(true);
            client = null;
            rej(new Error("wss failed"));
          });
          client.on("close", () => {});
          setTimeout(() => { client!.end(true); client = null; rej(new Error("timeout")); }, 10000);
        });

        entry.client = client;
        resolve(true);
        return;
      } catch (_) {
        // 降级到 tcp://
      }

      try {
        const mqtt = await import("mqtt");
        const clientId = `pi-led-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
        const tcpUrl = `tcp://${MQTT_BROKER}:${MQTT_PORT}`;
        console.log(`[AI红绿灯] 正在建立 MQTT 连接 (降级: ${tcpUrl})...`);

        let client = mqtt.connect(tcpUrl, {
          clientId,
          cleanSession: true,
          keepalive: 60,
          reconnectPeriod: 0,
          connectTimeout: 10000,
          protocolVersion: 4,
        });

        await new Promise<void>((res, rej) => {
          client.on("connect", () => {
            console.log("[AI红绿灯] ✅ MQTT tcp:// 已连接");
            res();
          });
          client.on("error", (err: Error) => {
            console.error(`[AI红绿灯] ❌ MQTT 错误: ${err.message}`);
          });
          client.on("close", () => {});
          setTimeout(() => { client!.end(true); client = null; rej(new Error("timeout")); }, 10000);
        });

        entry.client = client;
        resolve(true);
        return;
      } catch (e) {
        console.error("[AI红绿灯] ❌ 无法加载 mqtt 模块:", e);
        resolve(false);
        return;
      }
    })();
  });
}

// ====== 发布函数 ======

function publishState(state: string, message?: string): void {
  const entry = getGlobalEntry();

  if (!entry.client || !entry.client.connected) {
    console.warn(`[AI红绿灯] MQTT 未连接，跳过 ${state}`);
    return;
  }

  lastState = state;

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

// ====== 辅助函数 ======

/**
 * 设置带自动恢复的临时状态。
 * 注意：回调中保存 snapshotOfIsAgentRunning 快照，避免竞态。
 */
function setStateWithRecover(state: string, message: string, durationMs: number, snapshotIsRunning: boolean): void {
  if (stateTimer) {
    clearTimeout(stateTimer);
    stateTimer = null;
  }

  publishState(state, message);

  stateTimer = setTimeout(() => {
    stateTimer = null;
    // 使用 snapshot（状态变化时的 snapshot）而非当前的 isAgentRunning
    // 这是修复 Bug #1 的关键：避免因 agent 周期切换导致误恢复
    if (snapshotIsRunning) {
      publishState(STATES.RUNNING, "AI 继续处理");
    } else {
      publishState(STATES.IDLE, "等待任务");
    }
  }, durationMs);
}

/**
 * 清除定时器 —— 但不要清除 agentSettledTimer
 * （Bug #1 修复：agent_start 不应该清空上一轮的降级定时器）
 */
function clearStateTimers(): void {
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  // 不再清除 settledTimeoutTimer！
}

// ====== 扩展入口 ======
export default async function (pi: ExtensionAPI) {
  // === factory 层：确保 MQTT 连接（全局唯一，不随 session 销毁） ===
  await ensureMQTTConnected();
  publishState(STATES.INIT, "Pi 启动中");

  // === 事件监听层 ===

  // --- Session 开始 ---
  pi.on("session_start", async () => {
    publishState(STATES.IDLE, "等待任务");
  });

  // --- Agent 开始：新工作周期 ---
  pi.on("agent_start", async () => {
    isAgentRunning = true;

    // 本工作周期的唯一标识
    agentRunId++;

    // 重置错误报告状态
    hasReportedError = false;
    reportedErrorTool = "";

    // 清除上一次的状态恢复定时器（但不碰 agent 降级定时器）
    clearStateTimers();

    publishState(STATES.RUNNING, "AI 处理中");
  });

  // --- Agent 结束：启动降级定时器 ---
  pi.on("agent_end", async () => {
    console.log("[AI红绿灯] agent_end 触发，启动降级定时器");

    // 清除之前的降级定时器（防止重复 agent_end 重置）
    if (settledTimeoutTimer) {
      clearTimeout(settledTimeoutTimer);
      settledTimeoutTimer = null;
    }

    // 标记本轮结束，阻止后续到达的工具错误
    // （修复 Bug #3：session shutdown 后不会遗留幽灵错误）
    const runIdAtEnd = agentRunId;

    // 启动 5 秒降级定时器
    settledTimeoutTimer = setTimeout(() => {
      settledTimeoutTimer = null;
      console.log("[AI红绿灯] agent_settled 超时（5s），降级为 DONE");
      // 双重检查：只有当 agentRunId 没变时才生效（防止新 round 覆盖）
      if (agentRunId === runIdAtEnd) {
        isAgentRunning = false;
        setStateWithRecover(STATES.DONE, "任务完成（降级）", TEMP_STATE_DURATION_MS, false);
      }
    }, AGENT_SETTLED_TIMEOUT_MS);
  });

  // --- Agent Settled：确定不会再继续 ---
  pi.on("agent_settled", async () => {
    console.log("[AI红绿灯] agent_settled 触发 — 所有处理完成");

    // 取消降级定时器
    if (settledTimeoutTimer) {
      clearTimeout(settledTimeoutTimer);
      settledTimeoutTimer = null;
    }

    isAgentRunning = false;
    setStateWithRecover(STATES.DONE, "任务完成", TEMP_STATE_DURATION_MS, false);
  });

  // --- 工具结果 ---
  pi.on("tool_result", async (event) => {
    if (event.isError) {
      const toolName = event.toolName || "unknown";
      console.log(`[AI红绿灯] 工具执行出错: ${toolName}`);

      // 修复 Bug #3: 如果已经过了 agent_end 或 session_shutdown，丢弃此事件
      // （这些延迟的 tool_result 属于上一轮，不应影响当前状态）
      if (agentRunId === 0) {
        console.log(`[AI红绿灯] ⏭️ 工具错误：不在任何 agent_run 周期内，忽略`);
        return;
      }

      // 修复 Bug #2: 同行内首个工具错误闪红，后续错误静默
      if (hasReportedError) {
        console.log(`[AI红绿灯] ⏭️ 工具错误：本轮已报告过错误 (${reportedErrorTool})，忽略`);
        return;
      }

      // 首次错误：闪红灯 3 秒
      hasReportedError = true;
      reportedErrorTool = toolName;

      // 快照当前状态：如果是 agent 运行期则恢复 running，否则恢复 idle
      setStateWithRecover(STATES.ERROR, `工具出错: ${toolName}`, TEMP_STATE_DURATION_MS, isAgentRunning);
    }
  });

  // --- Session 关闭 ---
  pi.on("session_shutdown", async () => {
    isAgentRunning = false;
    agentRunId++; // 递增 ID，使后续到达的事件被认为已过时
    clearStateTimers();
    // 修复 Bug #1: 不清除 settledTimeoutTimer —— 它需要正确完成
  });

  // --- 兜底心跳：每 25 秒保持与 broker 的连接活性 ---
  setInterval(() => {
    if (lastState) {
      publishState(lastState, "keepalive");
    }
  }, 25000);
}
