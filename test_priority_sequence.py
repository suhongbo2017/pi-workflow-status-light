"""AI 红绿灯 — 按优先级递增顺序测试状态主题"""
import paho.mqtt.client as mqtt
import time
import json
import sys

BROKER = "broker.emqx.io"
PORT = 1883
TOPIC_STATUS = "ai/status"
CLIENT_ID = "ai-traffic-light-test"

# 按优先级从低到高排列，确保每个状态都能覆盖前一个
# 优先级: CRITICAL(0) > ERROR(1) > RUNNING(2) > WAITING(3) > 
#          THROTTLED(4) > DONE(5) > INIT(6) > IDLE(7)
STATES = [
    ("idle",      "蓝色常亮",   4),
    ("init",      "紫色呼吸",   4),
    ("done",      "绿色常亮",   4),
    ("throttled", "橙色慢闪",   4),
    ("waiting",   "青色闪烁",   4),
    ("running",   "黄色闪烁",   4),
    ("error",     "红色常亮",   4),
    ("critical",  "红蓝交替",   5),
    ("idle",      "蓝色常亮",   3),  # 不会生效，因为critical优先级更高
]

client = mqtt.Client(client_id=CLIENT_ID)
client.connect(BROKER, PORT, 60)
client.loop_start()
time.sleep(0.5)

# 先清除所有 retained 消息
client.publish(TOPIC_STATUS, '', qos=1, retain=True)
time.sleep(0.5)
print("已清除 retained 消息")

print("\n========== 按优先级递增测试 ==========\n")

for state, label, duration in STATES:
    payload = json.dumps({"state": state})
    client.publish(TOPIC_STATUS, payload, qos=1, retain=True)
    print(f"[状态] {state:12s} → {label}  (等待 {duration} 秒)")
    time.sleep(duration)

print("\n========== 测试完成 ==========")
print("注意: idle 最后不会生效，因为 critical 优先级最高")

client.loop_stop()
client.disconnect()