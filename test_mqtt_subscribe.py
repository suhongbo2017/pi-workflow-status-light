"""
AI Traffic Light - MQTT Subscribe Monitor

Monitors all messages on ai/status and ai/led/command topics.
Useful for debugging and verifying message flow.

Usage:
  python test_mqtt_subscribe.py
  python test_mqtt_subscribe.py --broker broker.emqx.io
"""

import paho.mqtt.client as mqtt
import json
import argparse
import sys
from datetime import datetime

TOPIC_STATUS = "ai/status"
TOPIC_COMMAND = "ai/led/command"


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f"[OK] Connected to MQTT Broker")
        client.subscribe(TOPIC_STATUS, 1)
        client.subscribe(TOPIC_COMMAND, 1)
        print(f"[SUB] {TOPIC_STATUS} (QoS 1)")
        print(f"[SUB] {TOPIC_COMMAND} (QoS 1)")
        print()
        print("Waiting for messages... (Ctrl+C to stop)")
        print("-" * 60)
    else:
        print(f"[FAIL] Connection failed, rc={rc}")
        sys.exit(1)


def on_message(client, userdata, msg):
    now = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    payload = msg.payload.decode("utf-8")
    
    print(f"[{now}] {msg.topic}")
    print(f"  Payload: {payload}")
    
    # Try to pretty-print JSON
    try:
        data = json.loads(payload)
        print(f"  State: {data.get('state', 'N/A')}")
        if data.get('message'):
            print(f"  Msg:   {data['message']}")
    except json.JSONDecodeError:
        pass
    print()


def main():
    parser = argparse.ArgumentParser(description="AI Traffic Light MQTT Monitor")
    parser.add_argument("--broker", default="broker.emqx.io", help="MQTT broker address")
    parser.add_argument("--port", type=int, default=1883, help="MQTT port")
    
    args = parser.parse_args()
    
    print(f"[MQTT] Connecting to {args.broker}:{args.port} ...")
    print(f"[MQTT] Monitoring topics: {TOPIC_STATUS}, {TOPIC_COMMAND}")
    print()
    
    client = mqtt.Client(client_id="ai-traffic-light-monitor")
    client.on_connect = on_connect
    client.on_message = on_message
    
    try:
        client.connect(args.broker, args.port, 60)
        client.loop_forever()
    except KeyboardInterrupt:
        print("\n[DONE] Monitor stopped")
    except Exception as e:
        print(f"[FAIL] Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()