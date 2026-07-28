@echo off
chcp 65001 >nul
echo ========================================
echo   AI Traffic Light - Quick Test Menu
echo ========================================
echo.
echo  1. Full demo (all states cycle)
echo  2. Set state: running
echo  3. Set state: done
echo  4. Set state: error
echo  5. Set state: idle
echo  6. Set state: critical
echo  7. Direct LED: blink:yellow
echo  8. Direct LED: breath:purple
echo  9. Direct LED: red
echo  10. Monitor MQTT messages
echo.
echo  0. Exit
echo ========================================
echo.

set /p choice="Select (0-10): "

if "%choice%"=="1" python test_mqtt_publish.py
if "%choice%"=="2" python test_mqtt_publish.py --state running --msg "AI is processing..."
if "%choice%"=="3" python test_mqtt_publish.py --state done --msg "Task completed successfully"
if "%choice%"=="4" python test_mqtt_publish.py --state error --msg "Error occurred"
if "%choice%"=="5" python test_mqtt_publish.py --state idle
if "%choice%"=="6" python test_mqtt_publish.py --state critical --msg "Network disconnected"
if "%choice%"=="7" python test_mqtt_publish.py --cmd "blink:yellow"
if "%choice%"=="8" python test_mqtt_publish.py --cmd "breath:purple"
if "%choice%"=="9" python test_mqtt_publish.py --cmd "red"
if "%choice%"=="10" python test_mqtt_subscribe.py
if "%choice%"=="0" exit /b

if "%choice%"=="" echo Invalid choice

pause
echo.
echo Restarting menu...
call test_demo.bat