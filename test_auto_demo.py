"""AI 红绿灯 — 无交互全状态自动测试"""
import paho.mqtt.client as mqtt
import time
import json
import sys

BROKER = "broker.emqx.io"
PORT = 1883
TOPIC_STATUS = "ai/status"
CLIENT_ID = "ai-traffic-light-test"

STATES = [
    ("init",      "紫色呼吸",  4),
    ("idle",      "蓝色常亮",  3),
    ("running",   "黄色闪烁",  4),
    ("done",      "绿色常亮",  3),
    ("error",     "红色常亮",  3),
    ("waiting",   "青色闪烁",  3),
    ("throttled", "橙色慢闪",  4),
    ("critical",  "红蓝交替",  4),
    ("idle",      "蓝色常亮",  3),
]

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f"[OK] 已连接 MQTT ({BROKER}:{PORT})")
    else:
        print(f"[FAIL] 连接失败: {rc}")
        sys.exit(1)

def on_publish(client, userdata, mid):
    print(f"  [OK] 已发送 (mid={mid})")

client = mqtt.Client(client_id=CLIENT_ID)
client.on_connect = on_connect
client.on_publish = on_publish

print(f"[MQTT] 连接 {BROKER}:{PORT} ...")
client.connect(BROKER, PORT, 60)
client.loop_start()
time.sleep(0.5)

print("\n========== 开始全状态测试 ==========\n")

for state, label, duration in STATES:
    payload = json.dumps({"state": state})
    client.publish(TOPIC_STATUS, payload, qos=1, retain=True)
    print(f"[SEND] {state:12s} → {label}  (等待 {duration} 秒)")
    time.sleep(duration)

print("\n========== 测试完成 ==========")

client.loop_stop()
client.disconnect()