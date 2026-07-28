@echo off
chcp 65001 >nul
echo ================================
echo  AI红绿灯 - 快速测试
echo ================================
echo 发布状态到 broker.emqx.io
echo.

python test_mqtt_publish.py --state init --msg "系统初始化中..."
timeout /t 3 /nobreak >nul

python test_mqtt_publish.py --state idle --msg "空闲待命"
timeout /t 3 /nobreak >nul

python test_mqtt_publish.py --state running --msg "AI正在分析财报..."
timeout /t 5 /nobreak >nul

python test_mqtt_publish.py --state waiting --msg "等待用户输入"
timeout /t 3 /nobreak >nul

python test_mqtt_publish.py --state throttled --msg "API限流中"
timeout /t 4 /nobreak >nul

python test_mqtt_publish.py --state done --msg "任务完成"
timeout /t 3 /nobreak >nul

python test_mqtt_publish.py --state error --msg "出错了"
timeout /t 3 /nobreak >nul

python test_mqtt_publish.py --state critical --msg "严重故障"
timeout /t 4 /nobreak >nul

python test_mqtt_publish.py --state idle --msg "恢复正常"
echo.
echo ================================
echo  测试完成！
echo  观察ESP32上的3颗灯珠变化
echo ================================
pause