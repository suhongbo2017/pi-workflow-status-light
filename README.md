# 🚦 AI红绿灯 — ESP32-S3 AI 工作流状态指示器

通过 3 颗 WS2812B 灯珠（一字排开）和 ESP32-S3，实时显示 AI 工作流的运行状态。放在桌面上，一眼就知道 AI 在干嘛。

## 功能一览

| 状态 | 颜色 | 效果 | 含义 |
|------|------|------|------|
| 🔵 `init` | 紫色 | 呼吸 | 系统启动/连接中 |
| 🔵 `idle` | 蓝色 | 常亮 | 等待任务，系统就绪 |
| 🟡 `running` | 黄色 | 跑马灯 600ms | AI 正在处理 |
| 🟢 `done` | 绿色 | 常亮 | 任务成功完成 |
| 🔴 `error` | 红色 | 常亮 | 出错或停止 |
| 🔵 `waiting` | 青色 | 闪烁 300ms | 等待用户输入 |
| 🟠 `throttled` | 白色 | 闪烁 800ms | API 限流/冷却 |
| 🔴🔵 `critical` | 红蓝 | 交替闪烁 | 严重故障/断网 |

## 硬件

- **主控**: ESP32-S3 (Freenove WROOM / LilyGO T-Display S3)
- **LED**: 3 颗 WS2812B 灯珠，一字排开，通过 3Pin 接口外接
- **引脚**: GPIO12 → WS2812B DATA
- **供电**: USB 5V

### 接线

```
ESP32-S3 GPIO12 ──── WS2812B DIN
ESP32-S3 3.3V   ──── WS2812B VCC
ESP32-S3 GND    ──── WS2812B GND
```

## 软件架构

```
ai-traffic-light/
├── platformio.ini      # PlatformIO 配置
├── data/
│   └── config.json     # SPIFFS 配置文件示例
├── include/
│   ├── Config.h        # 全局配置（硬编码默认值）
│   ├── StateMachine.h  # 状态机定义
│   └── LEDEffects.h    # LED 效果引擎定义
└── src/
    ├── main.cpp         # 主程序（WiFi + MQTT + 状态机 + LED）
    ├── StateMachine.cpp # 状态机实现
    └── LEDEffects.cpp   # LED 效果引擎实现
```

## MQTT 协议

### 订阅（接收）

| Topic | 格式 | 说明 |
|-------|------|------|
| `ai/status` | `{"state":"running","message":"..."}` | 工作流状态 |
| `ai/led/command` | `"red"` / `"blink:yellow"` / `"breath:purple"` | 直接控制 LED |

### 发布（发送）

| Topic | 格式 | 说明 |
|-------|------|------|
| `ai/status` | `{"state":"heartbeat"}` | 心跳（30秒间隔） |
| `ai/status` | `{"state":"idle"}` | 上线通知（Retained） |
| `ai/status` | `{"state":"offline"}` | 断线通知（LWT） |

### 支持的 state 值

`idle`, `running`, `done`, `error`, `init`, `waiting`, `throttled`, `critical`

### 支持的 command 格式

- `"red"` / `"green"` / `"blue"` — 常亮指定颜色
- `"blink:yellow"` / `"blink:cyan"` — 闪烁
- `"breath:purple"` / `"breath:blue"` — 呼吸
- `"chase:yellow"` — 跑马灯（流水灯）
- `"alternate:red"` — 交替闪烁

## 使用方式

### 1. 配置 WiFi/MQTT

**方式 A**: 编辑 `data/config.json`，上传到 SPIFFS

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

**方式 B**: 在 `include/Config.h` 中硬编码默认值（配置文件不存在时自动回退）

### 2. 编译上传

```bash
# 上传 SPIFFS 配置
pio run --target uploadfs

# 编译并上传固件
pio run --target upload

# 监视串口
pio device monitor
```

### 3. 发送状态消息

```bash
# AI 工作流正在运行
mosquitto_pub -t "ai/status" -m '{"state":"running","message":"正在分析财报..."}' -r

# AI 工作流完成
mosquitto_pub -t "ai/status" -m '{"state":"done","message":"分析完成"}' -r

# 直接控制 LED 颜色
mosquitto_pub -t "ai/led/command" -m "blink:yellow"
```

## 行为特性

- **上电**: 紫色呼吸 → 连接 WiFi → 连接 MQTT → 读取保留消息 → 显示对应状态
- **离线**: WiFi/MQTT 断开后亮度降至 2%，保持最后颜色，自动重连
- **严重故障**: 连续 3 次 MQTT 连接失败 → 红蓝交替闪烁
- **超时降级**: 启动后 10 秒未收到状态消息 → 自动进入空闲模式
- **心跳**: 每 30 秒发布一次心跳，用于监控设备在线状态
- **Retained**: 开启，新设备上线自动获取最新状态
- **LWT**: 开启，断线时自动发布离线状态

## Pi 编码助手集成

安装 [Pi 编码助手](https://github.com/earendil-works/pi-coding-agent) 扩展后，Pi 的运行状态会自动反映到 AI 红绿灯上。

### 安装扩展

扩展已放置在 `~/.pi/agent/extensions/ai-traffic-light/`，Pi 会自动发现并加载。

```bash
# 安装依赖（已安装可跳过）
cd ~/.pi/agent/extensions/ai-traffic-light
npm install
```

### 状态映射

| Pi 事件 | 状态 | LED 效果 |
|---------|------|----------|
| Pi 启动 | `init` | 紫色呼吸 |
| 等待用户输入 | `idle` | 蓝色常亮 |
| AI 正在处理 | `running` | 黄色跑马灯 |
| 任务完成 (`agent_settled`) | `done` | 绿色常亮（3秒后→idle） |
| 工具执行出错 | `error` | 红色常亮（3秒后恢复） |

### 验证

打开 Pi 后，AI 红绿灯会显示紫色呼吸 → 蓝色常亮。
向 Pi 提问时，灯变为黄色闪烁，回答完成变为绿色，3秒后回到蓝色。

也可通过 MQTT 订阅验证消息流：

```bash
python test_mqtt_subscribe.py
```

## 开发

```bash
# 仅编译
pio run

# 编译并上传
pio run --target upload

# 监视串口
pio device monitor -b 115200

# 上传 SPIFFS
pio run --target uploadfs

# 清理
pio run --target clean
```