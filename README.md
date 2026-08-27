# 🚦 AI Traffic Light — ESP32-S3 AI Workflow Status Indicator

通过 **9 颗 WS2812B 灯珠**（一字排开）和 **ESP32-S3**，实时显示 AI 工作流的运行状态。放在桌面上，一眼就知道 AI 在干嘛。

## 功能一览

| 状态 | 颜色 | 效果 | 周期 | 含义 |
|------|------|------|------|------|
| `init` | 紫色 | 呼吸 | 2s | 系统启动 / 连接中 |
| `idle` | 蓝色 | 常亮 | — | 等待任务，系统就绪 |
| `running` | 黄色 | 渐变流水灯 | 7.2s | AI 正在处理 |
| `done` | 绿色 | 常亮 | — | 任务成功完成 |
| `error` | 红色 | 常亮 | — | 出错或停止 |
| `waiting` | 青色 | 闪烁 | 300ms | 等待用户输入 |
| `throttled` | 橙色(白) | 慢闪 | 800ms | API 限流 / 冷却 |
| `critical` | 红+蓝 | 交替闪烁 | 500ms | 严重故障 / 断网 |

> ⚠️ `throttled` 当前显示为白色，后续版本可调整为真正的橙色以更好区分。

## 硬件

### 规格

- **主控**: ESP32-S3 (Freenove WROOM / LilyGO T-Display S3)
- **Flash**: 16MB, **PSRAM**: 8MB
- **LED**: 9 × WS2812B 全彩 LED 灯珠，一字排开
- **引脚**: `GPIO12` → WS2812B DATA
- **供电**: USB 5V

### 接线

```
ESP32-S3 GPIO12 ──── WS2812B DIN
ESP32-S3 5V/VCC ──── WS2812B VCC (建议 5V)
ESP32-S3 GND    ──── WS2812B GND
```

## 软件架构

```
ai-traffic-light/
├── platformio.ini          # PlatformIO / ESP32-S3 工程配置
├── include/
│   ├── Config.h            # 全局配置：WiFi/MQTT/LED 参数
│   ├── StateMachine.h      # 状态机 & 效果类型定义
│   └── LEDEffects.h        # LED 效果引擎声明
└── src/
    ├── main.cpp             # 主程序：WiFi + MQTT + 状态机 + LED 驱动
    ├── StateMachine.cpp     # 状态机实现：优先级覆盖、状态→效果映射
    └── LEDEffects.cpp       # LED 效果引擎：SOLID / BLINK / BREATH / CHASE / ALTERNATE
```

### 核心设计

```
MQTT 消息 ──→ StateMachine ──→ getEffectForState() ──→ LEDEffectsEngine ──→ FastLED.show()
                   │                                          ^
                   ▼                                          │
              优先级判断                                    亮度调节
         (CRITICAL > ERROR > … > IDLE)                    (~8%)
```

- **8 个工作流状态**，按优先级从高到低排列：`CRITICAL(0) > ERROR(1) > RUNNING(2) > WAITING(3) > THROTTLED(4) > DONE(5) > INIT(6) > IDLE(7)`
- **优先级机制**：高优先级状态自动覆盖低优先级；同状态允许刷新
- **强制设置**：MQTT 消息可通过 `forceSetState()` 覆盖所有状态（包括 CRITICAL）
- **离线模式**：WiFi/MQTT 断开后亮度降至 ~1%（3/255），保持最后颜色，持续自动重连

## MQTT 协议

### 订阅（接收命令）

| Topic | 格式 | 说明 |
|-------|------|------|
| `ai/status` | `{"state":"running","message":"..."}` | 工作流状态变更（Retained） |
| `ai/led/command` | `"red"` / `"blink:yellow"` / `"breath:purple"` | 直接控制 LED 效果 |

### 发布（发送）

| Topic | 格式 | 说明 |
|-------|------|------|
| `ai/status` | `{"state":"heartbeat"}` | 心跳（30 秒间隔） |
| `ai/status` | `{"state":"idle"}` | 上线通知（Retained） |
| `ai/status` | `{"state":"offline"}` | 断线通知（LWT Last Will） |

### 支持的 state 值

`idle`, `running`, `done`, `error`, `init`, `waiting`, `throttled`, `critical`

### 支持的 command 格式

| 格式 | 效果 |
|------|------|
| `"red"` / `"green"` / `"blue"` / `"yellow"` / `"cyan"` / `"magenta"` / `"purple"` / `"white"` | 常亮指定颜色 |
| `"blink:yellow"` / `"blink:cyan"` | 闪烁（固定频率） |
| `"breath:purple"` / `"breath:blue"` | 呼吸（正弦波渐变） |
| `"chase:yellow"` | 渐变流水灯（平滑余弦过渡） |
| `"alternate:red"` | 双色交替闪烁 |

## 使用方式

### 1. 配置 WiFi / MQTT

**方式 A**：编辑 `include/Config.h` 中的默认值

```cpp
// Config.h 顶部的宏定义
#define WIFI_SSID "MyWiFi"
#define WIFI_PASS "MyPassword"
#define MQTT_BROKER "broker.emqx.io"
#define MQTT_PORT 1883
```

> 项目使用硬编码默认值（公共 broker `broker.emqx.io`），无需 SPIFFS 配置文件即可开箱即用。

**方式 B**：创建 `data/config.json` 上传到 SPIFFS 覆盖默认值

```json
{
    "wifi": {
        "ssid": "MyWiFi",
        "password": "MyPassword"
    },
    "mqtt": {
        "host": "192.168.1.100",
        "port": 1883,
        "user": "",
        "pass": ""
    }
}
```

### 2. 编译 & 上传

```bash
# 编译并上传固件
pio run -e esp32-s3-dev --target upload

# 监视串口日志
pio device monitor -b 115200

# 清理构建缓存
pio run --target clean
```

### 3. 发送状态消息

```bash
# 发布工作状态
mosquitto_pub -t "ai/status" -m '{"state":"running"}' -r

# 直接控制 LED
mosquitto_pub -t "ai/led/command" -m "blink:yellow"

# Python 脚本测试
python test_mqtt_publish.py --state running --msg "正在分析财报..."
python test_mqtt_subscribe.py          # 监听 MQTT 消息
```

## 行为特性

- **上电**：紫色呼吸 → 连接 WiFi → 连接 MQTT → 读取保留消息 → 显示对应状态
- **离线**：WiFi/MQTT 断开后亮度降至 ~1%，保持最后颜色，每 5 秒尝试重连
- **严重故障**：连续 3 次 MQTT 连接失败 → 进入 `critical` 状态（红蓝交替闪烁）
- **超时降级**：启动后 10 秒未收到状态消息 → 自动进入 `idle` 模式（蓝色常亮）
- **心跳**：每 30 秒发布一次心跳，用于监控设备在线状态
- **Retained**：启用 Retained Message，新设备上线自动获取最新状态
- **LWT**：启用 Last Will Testament，断线时自动发布离线状态

## Pi 编码助手集成

安装 [Pi 编码助手](https://github.com/earendil-works/pi-coding-agent) 扩展后，Pi 的运行状态会自动反映到 AI 红绿灯上。

### 安装扩展

扩展已放置在 `~/.pi/agent/extensions/ai-traffic-light/`，Pi 会自动发现并加载。

```bash
cd ~/.pi/agent/extensions/ai-traffic-light
npm install
```

### 状态映射

| Pi 事件 | 状态 | LED 效果 |
|---------|------|----------|
| Pi 启动 | `init` | 紫色呼吸 |
| 等待用户输入 | `idle` | 蓝色常亮 |
| AI 正在处理 | `running` | 黄色渐变流水灯 |
| 任务完成 (`agent_settled`) | `done` | 绿色常亮（3 秒后→idle） |
| 工具执行出错 | `error` | 红色常亮（3 秒后恢复） |

### 验证

打开 Pi 后，AI 红绿灯会显示紫色呼吸 → 蓝色常亮。
向 Pi 提问时，灯变为黄色流水灯，回答完成变为绿色，3 秒后回到蓝色。

也可通过 MQTT 订阅验证消息流：

```bash
python test_mqtt_subscribe.py
```

## 测试

### Python 测试脚本

| 脚本 | 用途 |
|------|------|
| `test_led_direct.py` | 直接 LED 命令测试（跳过优先级逻辑） |
| `test_priority_sequence.py` | 按优先级递增顺序测试状态覆盖 |
| `test_all_states.py` | 全状态切换 + 串口日志同步读取 |
| `test_mqtt_publish.py` | 手动发布单条状态 / 直接命令 |
| `test_mqtt_subscribe.py` | 监听 MQTT 消息 |
| `test_auto_demo.py` | 完整自动化演示循环 |

### 快速测试

```bash
# Windows: 双击 .bat 文件
start test_quick.bat

# Linux / macOS / Git Bash
python test_led_direct.py && python test_priority_sequence.py
```

### 全量测试流程

```bash
# 1. 直接 LED 命令（9 种效果逐一触发）
python test_led_direct.py

# 2. 优先级顺序测试（从 low→high 确保覆盖正确）
python test_priority_sequence.py

# 3. 全流程测试（MQTT + 串口日志同步）
python test_all_states.py

# 4. 发布单条状态
python test_mqtt_publish.py --state running
python test_mqtt_publish.py --cmd "blink:yellow"
```

## 开发

### 平台

- **框架**: Arduino Core for ESP32 v2.0.17
- **依赖库**: FastLED ^3.9.12, PubSubClient ^2.8, ArduinoJson ^7.3
- **目标板**: `freenove_esp32_s3_wroom`（16MB Flash, 8MB PSRAM）
- **构建工具**: PlatformIO CLI

### 常用命令

```bash
pio run                          # 仅编译
pio run -e esp32-s3-dev          # 指定环境编译
pio run -e esp32-s3-dev --target upload   # 编译 + 烧录
pio device monitor -b 115200     # 串口监视
pio run --target clean           # 清理
```

### 优化记录

| # | 文件 | 改动 | 影响 |
|---|------|------|------|
| 1 | `main.cpp` | WiFi 连接 `delay(250)` → `delay(10)` + 超时计时器 | 防止 LED 帧冻结 10 秒 |
| 2 | `main.cpp` | `publishHeartbeat()` 增加 `mqttClient.connected()` 检查 + 用 `snprintf` 替代 JSON/String | 避免断线时无效内存分配 |
| 3 | `StateMachine.cpp` | `RUNNING` CHASE 周期 `600ms` → `7200ms` | 慢速渐变流水灯视觉效果 |
| 4 | `LEDEffects.cpp` | Chase 算法从单点跳跃改为余弦插值渐变流动 | 平滑水流灯效果 |
| 5 | `StateMachine.cpp` | `orange` 颜色从 `CRGB::White` → `CRGB(255, 165, 0)` | 真正橙色调 |
| 6 | `LEDEffects.h/cpp` | 移除重复的 `NUM_LEDS` 定义和无用的 `m_lastUpdateMs` 变量 | 代码整洁 |
| 7 | `main.cpp` | `enterOfflineMode` 添加 `BrightnessMultiplier` 同步调用 | 离线亮度一致生效 |

## License

MIT
