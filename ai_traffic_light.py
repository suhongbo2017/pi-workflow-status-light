"""
AI Traffic Light - Python Integration Module

Use this module to control the AI Traffic Light from your AI workflow scripts.

Usage:
    from ai_traffic_light import TrafficLight
    
    light = TrafficLight()
    
    # In your workflow:
    light.running("Analyzing financial data...")
    # ... do work ...
    light.done("Analysis complete")
    
    # Or on error:
    light.error("API rate limit exceeded")

Requirements:
    pip install paho-mqtt
"""

import paho.mqtt.client as mqtt
import json
import time
from typing import Optional


class TrafficLight:
    """Control the AI Traffic Light via MQTT"""
    
    def __init__(self, broker: str = "broker.emqx.io", port: int = 1883,
                 topic_status: str = "ai/status", 
                 topic_command: str = "ai/led/command",
                 client_id: str = "ai-workflow"):
        self.broker = broker
        self.port = port
        self.topic_status = topic_status
        self.topic_command = topic_command
        self.client_id = client_id
        self._client: Optional[mqtt.Client] = None
    
    def _connect(self):
        """Lazy connect to MQTT broker"""
        if self._client is None:
            self._client = mqtt.Client(client_id=self.client_id)
            self._client.connect(self.broker, self.port, 10)
            self._client.loop_start()
            time.sleep(0.2)
    
    def _publish(self, topic: str, payload: str, retain: bool = True):
        """Publish a message"""
        self._connect()
        result = self._client.publish(topic, payload, qos=1, retain=retain)
        return result
    
    def set_state(self, state: str, message: str = ""):
        """Set the traffic light state"""
        payload = {"state": state}
        if message:
            payload["message"] = message
        self._publish(self.topic_status, json.dumps(payload))
        return self
    
    def command(self, cmd: str):
        """Send direct LED command (e.g. 'blink:yellow', 'red', 'breath:purple')"""
        self._publish(self.topic_command, cmd, retain=False)
        return self
    
    # ====== Convenience methods ======
    
    def init(self, message: str = "System initializing..."):
        """Purple breath - system initializing"""
        return self.set_state("init", message)
    
    def idle(self, message: str = "System ready"):
        """Blue solid - idle, ready for tasks"""
        return self.set_state("idle", message)
    
    def running(self, message: str = "Processing..."):
        """Yellow chase (跑马灯) - AI workflow running"""
        return self.set_state("running", message)
    
    def waiting(self, message: str = "Waiting for input..."):
        """Cyan blink - waiting for user input"""
        return self.set_state("waiting", message)
    
    def throttled(self, message: str = "API throttled, cooling down..."):
        """Orange slow blink - API throttled"""
        return self.set_state("throttled", message)
    
    def done(self, message: str = "Task completed successfully"):
        """Green solid - task completed"""
        return self.set_state("done", message)
    
    def error(self, message: str = "Error occurred"):
        """Red solid - error occurred"""
        return self.set_state("error", message)
    
    def critical(self, message: str = "Critical failure"):
        """Red-blue alternate - critical failure"""
        return self.set_state("critical", message)
    
    def disconnect(self):
        """Disconnect from MQTT broker"""
        if self._client:
            self._client.loop_stop()
            self._client.disconnect()
            self._client = None


# ====== Context manager support ======
# Usage:
#   with TrafficLight() as light:
#       light.running("Working...")
#       # ... do work ...
#       light.done("Finished")

class TrafficLightContext(TrafficLight):
    def __enter__(self):
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is not None:
            self.error(f"Error: {exc_val}")
        else:
            self.done("Completed")
        self.disconnect()
        return False


# ====== Example usage ======
if __name__ == "__main__":
    import time
    
    print("AI Traffic Light - Example Usage")
    print("=" * 50)
    
    # Using context manager
    with TrafficLightContext() as light:
        light.running("Processing data...")
        time.sleep(2)
        
        light.waiting("Waiting for API response...")
        time.sleep(2)
        
        light.done("All tasks completed")
    
    # Manual usage
    light = TrafficLight()
    light.init("Booting up...")
    time.sleep(1)
    light.idle("Ready")
    time.sleep(1)
    light.running("Analyzing...")
    time.sleep(2)
    light.error("Something went wrong!")
    time.sleep(2)
    light.critical("Network lost!")
    time.sleep(2)
    light.disconnect()