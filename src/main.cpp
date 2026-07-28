/**
 * AI红绿灯 — ESP32-S3 AI 工作流状态指示器
 * 
 * 通过 3 颗 WS2812B 灯珠显示 AI 工作流的运行状态
 * 
 * MQTT topics:
 *   ai/status       — 监听工作流状态（JSON: {"state":"running", ...}）
 *   ai/led/command  — 直接控制 LED（"red" / "green" / "blue" / "blink:yellow" / "breath:purple"）
 *   ai/status       — 发布心跳（{"state":"heartbeat"}）
 * 
 * 配置文件（SPIFFS）:
 *   /config.json — WiFi/MQTT 配置参数
 */

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <SPIFFS.h>
#include "Config.h"
#include "StateMachine.h"
#include "LEDEffects.h"

// ====== 全局对象 ======
StateMachine g_stateMachine;
LEDEffectsEngine g_ledEngine;
WiFiClient g_wifiClient;
PubSubClient g_mqttClient(g_wifiClient);

// ====== 运行时配置（从文件读取或硬编码默认） ======
struct RuntimeConfig {
    char wifiSsid[32] = WIFI_SSID;
    char wifiPassword[64] = WIFI_PASSWORD;
    char mqttBroker[64] = MQTT_BROKER;
    uint16_t mqttPort = MQTT_PORT;
    char mqttUser[32] = MQTT_USER;
    char mqttPass[32] = MQTT_PASS;
} g_config;

// ====== 状态变量 ======
unsigned long g_lastHeartbeatMs = 0;
unsigned long g_lastMqttReconnectMs = 0;
unsigned long g_lastWifiReconnectMs = 0;
bool g_wifiConnected = false;
bool g_mqttConnected = false;
bool g_initialStateLoaded = false;
bool g_offlineMode = false;       // 离线模式标志
int g_mqttConnectFailCount = 0;   // 连续 MQTT 连接失败次数
bool g_criticalTriggered = false; // 是否已触发 critical 状态

// ====== 配置文件读写 ======
bool loadConfig() {
    if (!SPIFFS.begin(true)) {
        Serial.println("[SPIFFS] 挂载失败，使用默认配置");
        return false;
    }
    
    if (!SPIFFS.exists("/config.json")) {
        Serial.println("[SPIFFS] 配置文件 /config.json 不存在，使用默认配置");
        Serial.println("[SPIFFS] 请在 SPIFFS 中创建 /config.json:");
        Serial.println("  {");
        Serial.println("    \"wifi\": {\"ssid\":\"...\",\"password\":\"...\"},");
        Serial.println("    \"mqtt\": {\"host\":\"...\",\"port\":1883,\"user\":\"\",\"pass\":\"\"}");
        Serial.println("  }");
        return false;
    }
    
    File file = SPIFFS.open("/config.json", "r");
    if (!file) {
        Serial.println("[SPIFFS] 打开配置文件失败，使用默认配置");
        return false;
    }
    
    String content = file.readString();
    file.close();
    
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, content);
    if (error) {
        Serial.printf("[SPIFFS] 配置文件解析失败: %s\n", error.c_str());
        return false;
    }
    
    // 读取 WiFi 配置
    if (doc["wifi"]["ssid"]) {
        strlcpy(g_config.wifiSsid, doc["wifi"]["ssid"], sizeof(g_config.wifiSsid));
    }
    if (doc["wifi"]["password"]) {
        strlcpy(g_config.wifiPassword, doc["wifi"]["password"], sizeof(g_config.wifiPassword));
    }
    
    // 读取 MQTT 配置
    if (doc["mqtt"]["host"]) {
        strlcpy(g_config.mqttBroker, doc["mqtt"]["host"], sizeof(g_config.mqttBroker));
    }
    if (doc["mqtt"]["port"]) {
        g_config.mqttPort = doc["mqtt"]["port"];
    }
    if (doc["mqtt"]["user"]) {
        strlcpy(g_config.mqttUser, doc["mqtt"]["user"], sizeof(g_config.mqttUser));
    }
    if (doc["mqtt"]["pass"]) {
        strlcpy(g_config.mqttPass, doc["mqtt"]["pass"], sizeof(g_config.mqttPass));
    }
    
    Serial.println("[SPIFFS] 配置文件加载成功");
    Serial.printf("  WiFi SSID: %s\n", g_config.wifiSsid);
    Serial.printf("  MQTT Host: %s:%d\n", g_config.mqttBroker, g_config.mqttPort);
    return true;
}

// ====== WiFi 连接 ======
void connectWiFi() {
    Serial.print("[WiFi] 正在连接 ");
    Serial.print(g_config.wifiSsid);
    Serial.print(" ... ");
    
    WiFi.mode(WIFI_STA);
    WiFi.begin(g_config.wifiSsid, g_config.wifiPassword);
    
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 40) {
        delay(250);
        Serial.print(".");
        attempts++;
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println(" 已连接!");
        Serial.printf("[WiFi] IP 地址: %s\n", WiFi.localIP().toString().c_str());
        g_wifiConnected = true;
        g_offlineMode = false;
        // 恢复亮度
        g_ledEngine.setGlobalBrightness(25);
        g_stateMachine.setBrightnessMultiplier(25);
        Serial.println("[LED] 亮度已恢复 10%");
    } else {
        Serial.println(" 失败!");
        g_wifiConnected = false;
    }
}

// ====== MQTT 回调 ======
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    String message;
    for (unsigned int i = 0; i < length; i++) {
        message += (char)payload[i];
    }
    
    Serial.printf("[MQTT] 收到消息 | Topic: %s | Payload: %s\n", topic, message.c_str());

    // 处理 ai/led/command — 直接控制命令
    if (String(topic) == TOPIC_COMMAND) {
        message.trim();
        
        String effectType = "solid";
        String colorName = message;
        
        int colonPos = message.indexOf(':');
        if (colonPos > 0) {
            effectType = message.substring(0, colonPos);
            colorName = message.substring(colonPos + 1);
        }
        
        CRGB color = StateMachine::colorNameToRGB(colorName);
        LEDEffect effect;
        
        if (effectType == "blink") {
            effect.type = EffectType::BLINK;
            effect.color1 = color;
            effect.periodMs = 500;
        } else if (effectType == "breath") {
            effect.type = EffectType::BREATH;
            effect.color1 = color;
            effect.periodMs = 2000;
        } else if (effectType == "alternate") {
            effect.type = EffectType::ALTERNATE;
            effect.color1 = color;
            effect.color2 = CRGB::Black;
            effect.periodMs = 500;
        } else if (effectType == "chase") {
            effect.type = EffectType::CHASE;
            effect.color1 = color;
            effect.color2 = CRGB::Black;
            effect.periodMs = 600;
        } else {
            effect.type = EffectType::SOLID;
            effect.color1 = color;
        }
        
        effect.brightness = 255;
        g_ledEngine.setEffect(effect);
        Serial.printf("[LED] 直接控制: %s → %s\n", effectType.c_str(), colorName.c_str());
        return;
    }
    
    // 处理 ai/status — 工作流状态
    if (String(topic) == TOPIC_STATUS) {
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, message);
        
        if (error) {
            Serial.printf("[MQTT] JSON 解析失败: %s\n", error.c_str());
            return;
        }
        
        const char* state = doc["state"];
        if (state == nullptr) {
            Serial.println("[MQTT] 消息中没有 state 字段");
            return;
        }
        
        // 心跳消息不处理
        if (strcmp(state, "heartbeat") == 0) {
            return;
        }
        
        // 离线状态不改变灯光（已在离线模式中处理）
        if (strcmp(state, "offline") == 0) {
            return;
        }
        
        // 标记已加载初始状态
        g_initialStateLoaded = true;
        
        // 转换并设置状态（收到新消息时强制覆盖，包括 CRITICAL）
        WorkflowState ws = StateMachine::stringToState(state);
        g_stateMachine.forceSetState(ws);
        g_ledEngine.setEffect(g_stateMachine.getCurrentEffect());
        g_criticalTriggered = false; // 收到新状态时清除严重故障标志
        g_stateMachine.printState(Serial);
        
        // 如果有 message 字段，打印出来
        if (doc["message"]) {
            Serial.printf("[MQTT] 消息: %s\n", (const char*)doc["message"]);
        }
    }
}

// ====== MQTT 连接 ======
bool connectMQTT() {
    Serial.print("[MQTT] 正在连接 Broker ");
    Serial.print(g_config.mqttBroker);
    Serial.print(":");
    Serial.print(g_config.mqttPort);
    Serial.print(" ... ");
    
    g_mqttClient.setServer(g_config.mqttBroker, g_config.mqttPort);
    g_mqttClient.setCallback(mqttCallback);
    
    // LWT: 断线时 Broker 自动发布离线状态
    String lwtPayload = "{\"state\":\"offline\"}";
    
    bool connected = false;
    if (strlen(g_config.mqttUser) > 0) {
        connected = g_mqttClient.connect(MQTT_CLIENT_ID, 
                                          g_config.mqttUser, g_config.mqttPass,
                                          TOPIC_STATUS, 1, true, lwtPayload.c_str());
    } else {
        connected = g_mqttClient.connect(MQTT_CLIENT_ID, NULL, NULL,
                                          TOPIC_STATUS, 1, true, lwtPayload.c_str());
    }
    
    if (connected) {
        Serial.println(" 已连接!");
        g_mqttConnected = true;
        g_mqttConnectFailCount = 0;
        g_criticalTriggered = false;
        g_offlineMode = false;
        
        // 恢复亮度
        g_ledEngine.setGlobalBrightness(25);
        g_stateMachine.setBrightnessMultiplier(25);
        
        // 订阅 topic（QoS 1, 会收到 Retained 消息）
        g_mqttClient.subscribe(TOPIC_STATUS, 1);
        Serial.printf("[MQTT] 订阅: %s (QoS 1)\n", TOPIC_STATUS);
        g_mqttClient.subscribe(TOPIC_COMMAND, 1);
        Serial.printf("[MQTT] 订阅: %s (QoS 1)\n", TOPIC_COMMAND);
        
        // 发布在线状态（Retained）
        String onlinePayload = "{\"state\":\"idle\"}";
        g_mqttClient.publish(TOPIC_STATUS, onlinePayload.c_str(), true);
        
        return true;
    } else {
        Serial.printf(" 失败! (rc=%d)\n", g_mqttClient.state());
        g_mqttConnected = false;
        g_mqttConnectFailCount++;
        return false;
    }
}

// ====== 发布心跳 ======
void publishHeartbeat() {
    JsonDocument doc;
    doc["state"] = "heartbeat";
    
    String payload;
    serializeJson(doc, payload);
    
    bool ok = g_mqttClient.publish(TOPIC_HEARTBEAT, payload.c_str(), false);
    if (ok) {
        Serial.printf("[MQTT] 心跳已发送\n");
    }
}

// ====== 进入离线模式 ======
void enterOfflineMode() {
    if (!g_offlineMode) {
        g_offlineMode = true;
        Serial.println("[系统] 进入离线模式 — 亮度降至 10%");
        g_ledEngine.setGlobalBrightness(5);   // 离线时降到 2%
        g_stateMachine.setBrightnessMultiplier(5);
        // 重新应用当前效果（带降低的亮度）
        g_ledEngine.setEffect(g_stateMachine.getCurrentEffect());
    }
}

// ====== 退出离线模式 ======
void exitOfflineMode() {
    if (g_offlineMode) {
        g_offlineMode = false;
        Serial.println("[系统] 退出离线模式 — 亮度恢复 10%");
        g_ledEngine.setGlobalBrightness(25);
        g_stateMachine.setBrightnessMultiplier(25);
        g_ledEngine.setEffect(g_stateMachine.getCurrentEffect());
    }
}

// ====== 进入严重故障状态 ======
void enterCriticalState() {
    if (!g_criticalTriggered) {
        g_criticalTriggered = true;
        Serial.println("[系统] 严重故障 — 红蓝交替闪烁");
        g_stateMachine.setState(WorkflowState::CRITICAL);
        g_ledEngine.setEffect(g_stateMachine.getCurrentEffect());
    }
}

// ====== 设置函数 ======
void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n========================================");
    Serial.println("  AI 红绿灯 v1.0");
    Serial.println("========================================");

    // 初始化 LED
    g_ledEngine.begin();
    g_ledEngine.setGlobalBrightness(25);
    Serial.printf("[LED] FastLED 初始化完成 | 灯珠: %d | GPIO: %d | 亮度: 10%%\n", NUM_LEDS, LED_DATA_PIN);

    // 初始状态: 紫色呼吸 (初始化中)
    g_stateMachine.setState(WorkflowState::INIT);
    g_ledEngine.setEffect(g_stateMachine.getCurrentEffect());
    g_stateMachine.printState(Serial);

    // 加载配置文件
    loadConfig();
    
    // 连接 WiFi
    connectWiFi();
    
    // 连接 MQTT
    if (g_wifiConnected) {
        connectMQTT();
    }
    
    // 如果 MQTT 未连接，进入空闲
    if (!g_mqttConnected) {
        Serial.println("[MQTT] 未连接，进入空闲模式（等待重连）");
        g_stateMachine.setState(WorkflowState::IDLE);
        g_ledEngine.setEffect(g_stateMachine.getCurrentEffect());
    }
    
    g_lastHeartbeatMs = millis();
    g_lastMqttReconnectMs = millis();
    g_lastWifiReconnectMs = millis();
}

// ====== 主循环 ======
void loop() {
    unsigned long now = millis();

    // ====== WiFi 连接管理 ======
    if (WiFi.status() != WL_CONNECTED) {
        if (g_wifiConnected) {
            Serial.println("[WiFi] 连接断开!");
            g_wifiConnected = false;
            g_mqttConnected = false;
            enterOfflineMode();
        }
        
        // 每 5 秒重试
        if (now - g_lastWifiReconnectMs >= 5000) {
            g_lastWifiReconnectMs = now;
            connectWiFi();
        }
    } else {
        if (!g_wifiConnected) {
            g_wifiConnected = true;
            Serial.println("[WiFi] 已重新连接");
        }
        
        // ====== MQTT 连接管理 ======
        if (!g_mqttClient.connected()) {
            if (g_mqttConnected) {
                Serial.println("[MQTT] 连接断开!");
                g_mqttConnected = false;
                enterOfflineMode();
            }
            
            // 每 10 秒重试
            if (now - g_lastMqttReconnectMs >= 10000) {
                g_lastMqttReconnectMs = now;
                bool ok = connectMQTT();
                
                // 连续 3 次 MQTT 连接失败 → 触发 critical
                if (!ok && g_mqttConnectFailCount >= 3) {
                    enterCriticalState();
                }
            }
        } else {
            // MQTT 已连接
            g_mqttClient.loop();
            
            if (!g_mqttConnected) {
                g_mqttConnected = true;
                g_mqttConnectFailCount = 0;
                g_criticalTriggered = false;
                exitOfflineMode();
                Serial.println("[MQTT] 已重新连接");
            }
            
            // ====== 心跳 ======
            if (now - g_lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
                g_lastHeartbeatMs = now;
                publishHeartbeat();
            }
        }
    }

    // ====== 超时降级：启动后 10 秒仍未收到状态消息 → idle ======
    if (!g_initialStateLoaded && g_wifiConnected && g_mqttConnected && (now > 10000)) {
        Serial.println("[系统] 未收到状态消息，进入空闲模式");
        g_stateMachine.setState(WorkflowState::IDLE);
        g_ledEngine.setEffect(g_stateMachine.getCurrentEffect());
        g_initialStateLoaded = true;
    }

    // ====== 更新状态机 ======
    g_stateMachine.update();

    // ====== 更新 LED 效果 ======
    g_ledEngine.update();

    delay(20); // ~50fps
}