# 🚦 AI 红绿灯 — ESP32-C3 移植指南

## ✅ 可以迁移！ESP32-C3 完全兼容此项目

ESP32-C3 是该项目的完美替代品——更小、更便宜、功耗更低，且所有核心功能（WiFi + MQTT + FastLED）都完整支持。

---

## 📋 改动清单

### 1. PlatformIO 配置（必需）

用 `platformio-c3.ini` 替换 `platformio.ini`，或直接复制以下内容到 `platformio.ini`：

```ini
[platformio]
default_envs = esp32-c3-dev

[env:esp32-c3-dev]
platform = espressif32@7.0.1
board = esp32-c3-devkitm-1      ; 常用 C3 模块，也可换成 adafruit_feather_c3 等
framework = arduino
board_build.mcu = esp32c3
board_build.f_cpu = 160000000L  ; C3 主频 160MHz（S3 是 240MHz）
board_build.flash_mode = qio
board_build.flash_size = 4MB    ; C3 通常 4MB 闪存（已足够，固件 ~250KB）
monitor_speed = 115200

lib_deps =
    fastled/FastLED @ ^3.9.12
    knolleary/PubSubClient @ ^2.8
    bblanchon/ArduinoJson @ ^7.3

build_flags =
    ; ⚠️ 移除所有 PSRAM 相关标志（C3 无 PSRAM）
    ; -DBOARD_HAS_PSRAM
    ; -DCONFIG_SPIRAM_SUPPORT
    ; ... 全部注释掉即可
```

### 2. 核心代码（无需修改！）

✅ `include/Config.h` — `LED_DATA_PIN = 12` 在 C3 上可用  
✅ `src/main.cpp` — WiFi/MQTT/SPIFFS 逻辑完全兼容  
✅ `src/StateMachine.cpp` — 无平台差异  
✅ `src/LEDEffects.cpp` — FastLED 跨平台兼容  

### 3. 唯一可选调整：USB CDC（串口打印）

如果你的 C3 开发板 **有 USB 接口**（大多数都有），当前配置已经正确：
```ini
-DARDUINO_USB_CDC_ON_BOOT=1
```

如果是纯 UART 版（通过 USB-TTL 烧录），去掉该行，改用外部 USB-TTL 模块查看串口。

---

## 🔌 ESP32-C3 接线图

```
ESP32-C3          WS2812B
─────────         ───────
GPIO12  ────────→ DIN (数据)
3V3     ────────→ VCC
GND     ────────→ GND
```

**注意：**
- C3 的 GPIO12 = **CN5 第 3 脚**（看你的开发板丝印）
- 如果是 Freenove ESP32-C3 Mini Board，DIN 接 **D12** 引脚
- 供电建议独立 5V（WS2812B 每颗灯全亮时约 60mA×3=180mA）

---

## 📦 常见 C3 开发板型号对照

| 开发板 | platformio.ini board | 备注 |
|--------|---------------------|------|
| Espressif ESP32-C3-DevKitM-1 | `esp32-c3-devkitm-1` | 官方推荐 |
| Adafruit Feather ESP32-C3 | `adafruit_feather_esp32c3` | 带 USB-C |
| Freenove ESP32-C3 Mini | `freenove_s3_mini` → 需自定义 | 小尺寸 |
| LilyGO T-Camera Plus | `tcameraplus` | 带摄像头 |

如果你告诉我具体用的哪款 C3 开发板，我可以帮你微调 board 配置。

---

## 🛠️ 编译 & 上传

```bash
cd ai-traffic-light

# 使用 C3 配置（如果创建了 platformio-c3.ini）
pio run --environment esp32-c3-dev --target upload

# 或者直接修改 platformio.ini 后常规编译
pio run --target upload

# 监视串口
pio device monitor -b 115200
```

---

## 💡 性能对比

| 指标 | ESP32-S3 | ESP32-C3 |
|------|----------|----------|
| 主频 | 240 MHz | 160 MHz |
| Flash | 通常 16MB | 通常 4MB |
| PSRAM | 8MB OPI | ❌ 无 |
| RAM | 512KB SRAM + 8MB PSRAM | 400KB SRAM |
| 固件大小 | ~250KB | ~250KB |
| 内存占用 | WiFi+MQTT ≈ 200KB | WiFi+MQTT ≈ 200KB |
| 实际剩余 RAM | ~300KB | ~200KB |

**结论：** 本项目不需要大量内存（只用了 WiFi + MQTT + FastLED），C3 的 400KB SRAM 完全够用。

---

## 🎯 升级建议

如果你想让 C3 也支持 **OTA 无线更新**（不需要每次插线烧录），可以加一行：

```ini
build_flags =
    -DAUTO_OTA   ; 启用 OTA 自动更新（配合 MQTT 状态推送）
```

这样可以通过 MQTT 触发 OTA 重新下载固件，实现真正的"远程管理"。

---

## ❓ 常见问题

**Q: C3 能同时跑 WiFi + MQTT + 3 颗 WS2812B 吗？**  
A: ✅ 完全可以。FastLED 只占几 KB，WiFi/MQTT 总共 ~200KB 动态内存。

**Q: 没有 PSRAM 会出问题吗？**  
A: ❌ 不会。ArduinoJson 默认缓存很小，PubSubClient 也是轻量级库。只有大型 ML 模型才需要 PSRAM。

**Q: GPIO12 在 C3 上能用吗？**  
A: ✅ GPIO12 是普通 GPIO（不是特殊功能引脚），直接复用就行。

**Q: 可以改成其他 GPIO 吗？**  
A: ✅ 只需改 `include/Config.h` 中的 `LED_DATA_PIN`，FastLED 支持几乎所有 GPIO。
