"""
AI Traffic Light - MQTT Publish Test Script

Publishes status messages to a MQTT broker to test the ESP32 LED effects.

Usage:
  python test_mqtt_publish.py                    # Auto demo cycle
  python test_mqtt_publish.py --state running    # Manual state
  python test_mqtt_publish.py --cmd "blink:yellow"  # Direct LED control
  python test_mqtt_publish.py --broker 192.168.1.100  # Custom broker
"""

import paho.mqtt.client as mqtt
import time
import json
import argparse
import sys
import os

# Default config
BROKER = "broker.emqx.io"
PORT = 1883
TOPIC_STATUS = "ai/status"
TOPIC_COMMAND = "ai/led/command"
CLIENT_ID = "ai-traffic-light-test"

# All states with description and duration (seconds)
STATES = [
    ("init",      "[Purple Breath]  System initializing...", 4),
    ("idle",      "[Blue Solid]     Idle - ready for tasks", 3),
    ("running",   "[Yellow Blink]   AI workflow running", 5),
    ("waiting",   "[Cyan Blink]     Waiting for user input", 3),
    ("throttled", "[Orange Slow]    API throttled / cooling", 4),
    ("done",      "[Green Solid]    Task completed", 3),
    ("error",     "[Red Solid]      Error / stopped", 3),
    ("critical",  "[Red-Blue Alt]   Critical failure", 4),
    ("idle",      "[Blue Solid]     Back to idle", 3),
]


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f"[OK] Connected to MQTT Broker ({BROKER}:{PORT})")
    else:
        print(f"[FAIL] Connection failed, return code: {rc}")
        sys.exit(1)


def on_publish(client, userdata, mid):
    print(f"  [OK] Published (mid={mid})")


def publish_state(client, state, message=""):
    """Publish workflow state message (Retained)"""
    payload = {"state": state}
    if message:
        payload["message"] = message
    payload_str = json.dumps(payload)

    result = client.publish(TOPIC_STATUS, payload_str, qos=1, retain=True)
    print(f"[PUB] {TOPIC_STATUS} <- {payload_str}")
    return result


def publish_command(client, command):
    """Publish direct LED control command"""
    result = client.publish(TOPIC_COMMAND, command, qos=1)
    print(f"[CMD] {TOPIC_COMMAND} <- {command}")
    return result


def run_demo(client):
    """Auto demo cycle through all states"""
    border = "=" * 60
    print()
    print(border)
    print("  AI Traffic Light - Full State Demo")
    print(border)
    print(f"  Broker: {BROKER}:{PORT}")
    print(f"  Status Topic: {TOPIC_STATUS}")
    print(f"  Command Topic: {TOPIC_COMMAND}")
    print(border)
    print()

    input("Press Enter to start demo...")
    print()

    try:
        for state, desc, duration in STATES:
            print(f"\n>>> {desc} ({duration}s)")
            publish_state(client, state, desc.split("]")[1].strip() if "]" in desc else "")
            time.sleep(duration)

        print()
        print(border)
        print("  Demo complete! All states displayed.")
        print(border)

    except KeyboardInterrupt:
        print("\n[WARN] Demo interrupted")


def main():
    parser = argparse.ArgumentParser(description="AI Traffic Light MQTT Test Tool")
    parser.add_argument("--state", help="Publish a specific state (idle/running/done/error/init/waiting/throttled/critical)")
    parser.add_argument("--cmd", help="Direct LED control (red/blue/blink:yellow/breath:purple/alternate:red)")
    parser.add_argument("--msg", default="", help="Additional message text")
    parser.add_argument("--broker", default=BROKER, help=f"MQTT broker address (default: {BROKER})")
    parser.add_argument("--port", type=int, default=PORT, help=f"MQTT port (default: {PORT})")

    args = parser.parse_args()

    # Connect to MQTT
    print(f"[MQTT] Connecting to {args.broker}:{args.port} ...")
    client = mqtt.Client(client_id=CLIENT_ID)
    client.on_connect = on_connect
    client.on_publish = on_publish

    try:
        client.connect(args.broker, args.port, 60)
        client.loop_start()
        time.sleep(0.5)

        if args.state:
            valid_states = ["idle", "running", "done", "error", "init", "waiting", "throttled", "critical"]
            if args.state not in valid_states:
                print(f"[FAIL] Invalid state: {args.state}")
                print(f"  Valid states: {', '.join(valid_states)}")
                sys.exit(1)
            publish_state(client, args.state, args.msg)
            print(f"\n[OK] Published state: {args.state}")
            if args.msg:
                print(f"  Message: {args.msg}")

        elif args.cmd:
            publish_command(client, args.cmd)
            print(f"\n[OK] Sent command: {args.cmd}")

        else:
            run_demo(client)

        time.sleep(1)
        client.loop_stop()
        client.disconnect()
        print("\n[DONE] Disconnected")

    except Exception as e:
        print(f"[FAIL] Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()