#include "StateMachine.h"

StateMachine::StateMachine()
    : m_rawState(WorkflowState::INIT)
    , m_brightnessMultiplier(255)
{
}

void StateMachine::setState(WorkflowState state) {
    // INIT 是启动态，始终可以被任何状态覆盖
    // CRITICAL 只能由外部消息强制覆盖（通过 forceSetState）
    // 其他状态：高优先级（数值小）覆盖低优先级，同状态允许刷新
    if (m_rawState == WorkflowState::INIT || isHigherPriority(state, m_rawState) || state == m_rawState) {
        m_rawState = state;
    }
    // 低优先级状态不覆盖高优先级状态
}

void StateMachine::forceSetState(WorkflowState state) {
    // 强制设置，忽略优先级（用于 MQTT 消息覆盖 CRITICAL 等）
    m_rawState = state;
}

WorkflowState StateMachine::getEffectiveState() const {
    return m_rawState;
}

LEDEffect StateMachine::getCurrentEffect() const {
    LEDEffect effect = getEffectForState(m_rawState);
    effect.brightness = (effect.brightness * m_brightnessMultiplier) / 255;
    return effect;
}

void StateMachine::setBrightnessMultiplier(uint8_t multiplier) {
    m_brightnessMultiplier = multiplier;
}

uint8_t StateMachine::getBrightnessMultiplier() const {
    return m_brightnessMultiplier;
}

void StateMachine::update() {
    // 状态机更新逻辑（目前无额外逻辑，预留）
}

void StateMachine::printState(Stream& stream) const {
    stream.print("[StateMachine] State: ");
    stream.print(stateToString(m_rawState));
    stream.print(" | Brightness: ");
    stream.println(m_brightnessMultiplier);
}

const char* StateMachine::stateToString(WorkflowState state) {
    switch (state) {
        case WorkflowState::CRITICAL:  return "critical";
        case WorkflowState::ERROR:     return "error";
        case WorkflowState::RUNNING:   return "running";
        case WorkflowState::WAITING:   return "waiting";
        case WorkflowState::THROTTLED: return "throttled";
        case WorkflowState::DONE:      return "done";
        case WorkflowState::INIT:      return "init";
        case WorkflowState::IDLE:      return "idle";
        default:                       return "unknown";
    }
}

WorkflowState StateMachine::stringToState(const String& str) {
    if (str == "critical")  return WorkflowState::CRITICAL;
    if (str == "error")     return WorkflowState::ERROR;
    if (str == "running")   return WorkflowState::RUNNING;
    if (str == "waiting")   return WorkflowState::WAITING;
    if (str == "throttled") return WorkflowState::THROTTLED;
    if (str == "done")      return WorkflowState::DONE;
    if (str == "init")      return WorkflowState::INIT;
    if (str == "idle")      return WorkflowState::IDLE;
    return WorkflowState::IDLE; // 默认空闲
}

CRGB StateMachine::colorNameToRGB(const String& name) {
    if (name == "red")      return CRGB::Red;
    if (name == "green")    return CRGB::Green;
    if (name == "blue")     return CRGB::Blue;
    if (name == "yellow")   return CRGB::Yellow;
    if (name == "cyan")     return CRGB(0, 255, 180); // 纯青色（减少蓝色分量）
    if (name == "magenta")  return CRGB::Magenta;
    if (name == "purple")   return CRGB(255, 0, 255);
    if (name == "orange")   return CRGB::White; // 白色（与其他颜色明显区分）
    if (name == "white")    return CRGB::White;
    if (name == "black")    return CRGB::Black;
    return CRGB::Blue; // 默认蓝色
}

LEDEffect StateMachine::getEffectForState(WorkflowState state) {
    LEDEffect effect;
    effect.brightness = 255; // 默认全亮

    switch (state) {
        case WorkflowState::CRITICAL:
            effect.type = EffectType::ALTERNATE;
            effect.color1 = CRGB::Red;
            effect.color2 = CRGB::Blue;
            effect.periodMs = 500;
            break;

        case WorkflowState::ERROR:
            effect.type = EffectType::SOLID;
            effect.color1 = CRGB::Red;
            break;

        case WorkflowState::RUNNING:
            effect.type = EffectType::CHASE;
            effect.color1 = CRGB::Yellow;   // 主色：黄色
            effect.color2 = CRGB(0, 0, 0);  // 尾迹：黑色（熄灭）
            effect.periodMs = 600;          // 3颗灯珠，每颗200ms
            break;

        case WorkflowState::WAITING:
            effect.type = EffectType::BLINK;
            effect.color1 = CRGB(0, 255, 180); // 青色
            effect.periodMs = 300;
            break;

        case WorkflowState::THROTTLED:
            effect.type = EffectType::BLINK;
            effect.color1 = CRGB::White; // 白色（与其他颜色明显区分）
            effect.periodMs = 800;
            break;

        case WorkflowState::DONE:
            effect.type = EffectType::SOLID;
            effect.color1 = CRGB::Green;
            break;

        case WorkflowState::INIT:
            effect.type = EffectType::BREATH;
            effect.color1 = CRGB(255, 0, 255); // Purple
            effect.periodMs = 2000;
            break;

        case WorkflowState::IDLE:
            effect.type = EffectType::SOLID;
            effect.color1 = CRGB::Blue;
            break;
    }

    return effect;
}