#ifndef LED_EFFECTS_H
#define LED_EFFECTS_H

#include <Arduino.h>
#include <FastLED.h>
#include "Config.h"
#include "StateMachine.h"

// 灯珠数量
#define NUM_LEDS 3

// LED 效果引擎
class LEDEffectsEngine {
public:
    LEDEffectsEngine();

    // 初始化 FastLED
    void begin();

    // 设置灯光效果（由状态机驱动）
    void setEffect(const LEDEffect& effect);

    // 每帧调用（更新灯光效果）
    void update();

    // 设置全局亮度
    void setGlobalBrightness(uint8_t brightness);

    // 获取当前亮度
    uint8_t getGlobalBrightness() const;

    // 设置每颗灯珠的自定义颜色（用于流水灯等高级效果）
    void setCustomColors(const CRGB colors[NUM_LEDS]);

    // 清除自定义颜色，恢复由效果引擎控制
    void clearCustomColors();

    // 显示指定颜色（单色，所有灯珠）
    void showColor(CRGB color);

    // 关闭所有灯珠
    void clear();

private:
    // 效果渲染函数
    void renderSolid(const LEDEffect& effect, unsigned long now);
    void renderBlink(const LEDEffect& effect, unsigned long now);
    void renderBreath(const LEDEffect& effect, unsigned long now);
    void renderAlternate(const LEDEffect& effect, unsigned long now);
    void renderChase(const LEDEffect& effect, unsigned long now);

    CRGB m_leds[NUM_LEDS];
    LEDEffect m_currentEffect;
    unsigned long m_lastUpdateMs;
    bool m_useCustomColors;
    uint8_t m_globalBrightness;
};

#endif // LED_EFFECTS_H