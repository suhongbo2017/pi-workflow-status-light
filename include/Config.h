#ifndef CONFIG_H
#define CONFIG_H

// ====== WiFi 配置 ======
// 初始硬编码，后期可通过 SPIFFS 配置文件覆盖
#define WIFI_SSID       "JHS"
#define WIFI_PASSWORD   "jhs16888"

// ====== MQTT 配置 ======
#define MQTT_BROKER     "broker.emqx.io"
#define MQTT_PORT       1883
#define MQTT_USER       ""
#define MQTT_PASS       ""
#define MQTT_CLIENT_ID  "ai-traffic-light"

// ====== MQTT Topics ======
#define TOPIC_STATUS    "ai/status"         // 接收工作流状态
#define TOPIC_COMMAND   "ai/led/command"    // 直接控制 LED
#define TOPIC_HEARTBEAT "ai/status"         // 心跳发布（同一 topic）

// ====== 心跳间隔 ======
#define HEARTBEAT_INTERVAL_MS 30000

// ====== 引脚定义 ======
#define NUM_LEDS 3
#define LED_DATA_PIN 12

#endif // CONFIG_H