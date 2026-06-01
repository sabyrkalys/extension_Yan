@echo off
chcp 65001 > nul
echo ============================================
echo   Обновление расширения Astra Maps
echo ============================================
echo.

REM ── Настройки ──────────────────────────────
REM Укажи путь к папке расширения на этом ПК
set EXTENSION_DIR=%~dp0
REM IP сервера
set SERVER_IP=192.168.22.169
set SERVER_PORT=5001
set SERVER_URL=http://%SERVER_IP%:%SERVER_PORT%

echo Сервер: %SERVER_URL%
echo Папка расширения: %EXTENSION_DIR%
echo.

REM ── Проверяем доступность сервера ──────────
curl -s --connect-timeout 3 "%SERVER_URL%/version.json" > nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Сервер недоступен: %SERVER_URL%
    echo    Проверь подключение к сети
    pause
    exit /b 1
)

REM ── Проверяем текущую версию ────────────────
curl -s "%SERVER_URL%/version.json" -o "%TEMP%\astra_version_new.json"
for /f "tokens=2 delims=:, " %%v in ('findstr "version" "%TEMP%\astra_version_new.json"') do set NEW_VERSION=%%~v

echo Версия на сервере: %NEW_VERSION%

REM Читаем текущую версию из локального version.json
if exist "%EXTENSION_DIR%version.json" (
    for /f "tokens=2 delims=:, " %%v in ('findstr "version" "%EXTENSION_DIR%version.json"') do set CUR_VERSION=%%~v
    echo Текущая версия:   %CUR_VERSION%
    if "%NEW_VERSION%"=="%CUR_VERSION%" (
        echo.
        echo ✅ Уже установлена последняя версия.
        pause
        exit /b 0
    )
) else (
    echo Текущая версия:   не определена
)

echo.
echo Скачиваем обновление...
echo.

REM ── Скачиваем файлы ─────────────────────────
set ERRORS=0

call :download "content.js"
call :download "background.js"
call :download "inject.js"
call :download "manifest.json"
call :download "version.json"

if %ERRORS% gtr 0 (
    echo.
    echo ⚠️  Некоторые файлы не скачались. Проверь подключение.
) else (
    echo.
    echo ✅ Обновление установлено! Версия: %NEW_VERSION%
    echo.
    echo Теперь:
    echo   1. Открой браузер
    echo   2. Перейди на chrome://extensions
    echo   3. Нажми кнопку обновления (🔄) на расширении Astra Maps
)

pause
exit /b 0

REM ── Функция скачивания ───────────────────────
:download
echo Скачиваю %~1 ...
curl -s "%SERVER_URL%/%~1" -o "%EXTENSION_DIR%%~1"
if %errorlevel% neq 0 (
    echo   ❌ Ошибка скачивания %~1
    set /a ERRORS+=1
) else (
    echo   ✅ %~1
)
exit /b 0
