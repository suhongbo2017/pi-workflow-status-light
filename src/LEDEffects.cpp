#include "LEDEffects.h"
#include <math.h>

LEDEffectsEngine::LEDEffectsEngine()
    : m_useCustomColors(false)
    , m_globalBrightness(25)
{
    // 初始化 LED 数组为黑色
    for (int i = 0; i < NUM_LEDS; i++) {
        m_leds[i] = CRGB::Black;
    }
    m_currentEffect = LEDEffect();
}

void LEDEffectsEngine::begin() {
    FastLED.addLeds<WS2812B, LED_DATA_PIN, GRB>(m_leds, NUM_LEDS);
    FastLED.setBrightness(m_globalBrightness);
    FastLED.clear();
    FastLED.show();
}

void LEDEffectsEngine::setEffect(const LEDEffect& effect) {
    m_currentEffect = effect;
    m_useCustomColors = false;
}

void LEDEffectsEngine::update() {
    if (m_useCustomColors) {
        FastLED.show();
        return;
    }

    unsigned long now = millis();

    switch (m_currentEffect.type) {
        case EffectType::SOLID:
            renderSolid(m_currentEffect, now);
            break;
        case EffectType::BLINK:
            renderBlink(m_currentEffect, now);
            break;
        case EffectType::BREATH:
            renderBreath(m_currentEffect, now);
            break;
        case EffectType::ALTERNATE:
            renderAlternate(m_currentEffect, now);
            break;
        case EffectType::CHASE:
            renderChase(m_currentEffect, now);
            break;
    }

    FastLED.show();
}

void LEDEffectsEngine::setGlobalBrightness(uint8_t brightness) {
    m_globalBrightness = brightness;
    FastLED.setBrightness(brightness);
}

uint8_t LEDEffectsEngine::getGlobalBrightness() const {
    return m_globalBrightness;
}

void LEDEffectsEngine::setCustomColors(const CRGB colors[NUM_LEDS]) {
    for (int i = 0; i < NUM_LEDS; i++) {
        m_leds[i] = colors[i];
    }
    m_useCustomColors = true;
}

void LEDEffectsEngine::clearCustomColors() {
    m_useCustomColors = false;
}

void LEDEffectsEngine::showColor(CRGB color) {
    for (int i = 0; i < NUM_LEDS; i++) {
        m_leds[i] = color;
    }
    FastLED.show();
}

void LEDEffectsEngine::clear() {
    FastLED.clear();
    FastLED.show();
}

// ====== 效果渲染函数 ======

void LEDEffectsEngine::renderSolid(const LEDEffect& effect, unsigned long now) {
    for (int i = 0; i < NUM_LEDS; i++) {
        m_leds[i] = effect.color1;
    }
}

void LEDEffectsEngine::renderBlink(const LEDEffect& effect, unsigned long now) {
    // 根据周期计算闪烁状态
    uint16_t halfPeriod = effect.periodMs / 2;
    bool on = (now % effect.periodMs) < halfPeriod;
    
    CRGB color = on ? effect.color1 : CRGB::Black;
    for (int i = 0; i < NUM_LEDS; i++) {
        m_leds[i] = color;
    }
}

void LEDEffectsEngine::renderBreath(const LEDEffect& effect, unsigned long now) {
    // 正弦波呼吸效果
    // 使用 sin() 在 0 ~ π 范围内产生平滑的呼吸曲线
    float phase = (float)(now % effect.periodMs) / (float)effect.periodMs;
    // 使用 sin(phase * PI) 产生 0→1→0 的呼吸曲线
    float brightness = sin(phase * PI);
    
    // 应用呼吸亮度到颜色
    CRGB color = effect.color1;
    color.nscale8((uint8_t)(brightness * 255.0f));
    
    for (int i = 0; i < NUM_LEDS; i++) {
        m_leds[i] = color;
    }
}

void LEDEffectsEngine::renderAlternate(const LEDEffect& effect, unsigned long now) {
    // 交替闪烁：每次交替切换颜色
    uint16_t halfPeriod = effect.periodMs / 2;
    bool firstColor = (now % effect.periodMs) < halfPeriod;
    
    CRGB color = firstColor ? effect.color1 : effect.color2;
    for (int i = 0; i < NUM_LEDS; i++) {
        m_leds[i] = color;
    }
}

void LEDEffectsEngine::renderChase(const LEDEffect& effect, unsigned long now) {
    // 渐变流水灯：光斑宽度 ~3 颗灯，平滑余弦过渡
    // pos 从 0 流动到 NUM_LEDS，完整一轮回绕 = effect.periodMs
    float pos = ((float)(now % effect.periodMs) / (float)effect.periodMs) 
                * (float)NUM_LEDS;
    
    CRGB baseColor = effect.color1;
    const float SPREAD = 3.0f;  // 光斑宽度（核心发光范围）
    
    for (int i = 0; i < NUM_LEDS; i++) {
        float dist = (float)i - pos;
        // 包裹距离
        if (dist > (float)NUM_LEDS / 2.0f) dist -= (float)NUM_LEDS;
        if (dist < -(float)NUM_LEDS / 2.0f) dist += (float)NUM_LEDS;
        
        uint8_t brightness;
        if (dist >= SPREAD) {
            // 远处：显示尾迹色或熄灭
            CRGB trailColor = (effect.color2.r == 0 && effect.color2.g == 0 && effect.color2.b == 0)
                ? CRGB::Black
                : effect.color2;
            m_leds[i] = trailColor;
        } else {
            // 光斑内：余弦插值从最亮到全灭
            float t = dist / SPREAD;      // 0~1
            brightness = (uint8_t)((0.5f * (1.0f + cosf(t * PI))) * 255.0f);
            baseColor.nscale8(brightness);
            m_leds[i] = baseColor;
            baseColor = effect.color1;    // 重置
        }
    }
}