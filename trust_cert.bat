@echo off
chcp 65001 > nul
echo =============================================
echo  Установка SSL сертификата (Windows)
echo =============================================
echo.

set CERT_PATH=%~dp0cert.pem

if not exist "%CERT_PATH%" (
    echo ОШИБКА: cert.pem не найден рядом с этим файлом.
    echo Положи trust_cert.bat в папку ws-server рядом с cert.pem
    pause
    exit /b 1
)

echo Добавляем сертификат в доверенные корневые центры...
echo Если появится окно безопасности - нажми ДА.
echo.

certutil -addstore -f "ROOT" "%CERT_PATH%"

if %errorlevel% == 0 (
    echo.
    echo ✅ ГОТОВО! Сертификат установлен.
    echo    Chrome больше не будет показывать предупреждение.
    echo    Если Chrome был открыт - перезапусти его.
) else (
    echo.
    echo ❌ ОШИБКА. Попробуй:
    echo    1. Правой кнопкой на trust_cert.bat
    echo    2. Выбери "Запустить от имени администратора"
)

pause
