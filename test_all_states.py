"""
AI 红绿灯 — 全状态测试脚本
同时读取串口日志 + 逐个发布 MQTT 状态消息
"""

import serial
import time
import threading
import paho.mqtt.client as mqtt
import json

BROKER = "broker.emqx.io"
PORT = 1883
COM = "COM16"
BAUD = 115200

# 测试序列
states = [
    ("init",      "紫色呼吸",  3),
    ("idle",      "蓝色常亮",  3),
    ("running",   "黄色闪烁",  3),
    ("done",      "绿色常亮",  3),
    ("error",     "红色常亮",  3),
    ("waiting",   "青色闪烁",  3),
    ("throttled", "橙色慢闪",  3),
    ("critical",  "红蓝交替",  4),
    ("idle",      "蓝色常亮",  2),
]

serial_log = []

def serial_reader():
    try:
        ser = serial.Serial(COM, BAUD, timeout=1)
        time.sleep(0.5)
        print(f"[串口] 已打开 {COM}")
        while True:
            try:
                line = ser.readline().decode('utf-8', errors='replace').strip()
                if line and not line.startswith("---"):
                    serial_log.append(line)
                    print(f"[ESP32] {line}")
            except:
                break
        ser.close()
    except Exception as e:
        print(f"[串口] 错误: {e}")

def publish_state(state, label):
    client = mqtt.Client()
    client.connect(BROKER, PORT, 5)
    payload = json.dumps({"state": state})
    client.publish("ai/status", payload, qos=1, retain=True)
    client.disconnect()
    print(f"\n{'='*50}")
    print(f"[发送] {state} — {label}")
    print(f"{'='*50}")

# 启动串口读取线程
reader = threading.Thread(target=serial_reader, daemon=True)
reader.start()
time.sleep(1)

# 逐状态测试
for state, label, duration in states:
    publish_state(state, label)
    print(f"[等待] {duration} 秒观察 LED 效果...\n")
    time.sleep(duration)

print("\n" + "="*50)
print("测试完成！")
print("="*50)