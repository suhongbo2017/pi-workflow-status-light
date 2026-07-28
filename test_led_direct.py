"""AI 红绿灯 — 直接 LED 命令测试（绕过优先级保护）"""
import paho.mqtt.client as mqtt
import time
import sys

BROKER = "broker.emqx.io"
PORT = 1883
TOPIC_CMD = "ai/led/command"
CLIENT_ID = "ai-traffic-light-test"

# 直接 LED 命令序列
CMDS = [
    ("breath:purple",   "紫色呼吸",   4),   # init
    ("blue",            "蓝色常亮",   3),   # idle
    ("blink:yellow",    "黄色闪烁",   4),   # running
    ("green",           "绿色常亮",   3),   # done
    ("red",             "红色常亮",   3),   # error
    ("blink:cyan",      "青色闪烁",   3),   # waiting
    ("blink:orange",    "橙色慢闪",   4),   # throttled
    ("alternate:red",   "红蓝交替",   4),   # critical
    ("blue",            "蓝色常亮",   3),   # back to idle
]

client = mqtt.Client(client_id=CLIENT_ID)
client.connect(BROKER, PORT, 60)
client.loop_start()
time.sleep(0.5)

print("========== 全状态 LED 测试 ==========\n")

for cmd, label, duration in CMDS:
    client.publish(TOPIC_CMD, cmd, qos=1)
    print(f"[CMD] {cmd:20s} → {label}  (等待 {duration} 秒)")
    time.sleep(duration)

print("\n========== 测试完成 ==========")

client.loop_stop()
client.disconnect()