@echo off
chcp 65001 > nul
echo =============================================
echo  Генерация SSL сертификата
echo =============================================
echo.
echo ВАЖНО: укажи реальный IP сервера ниже
echo Текущий IP в скрипте: 192.168.22.103
echo.

set IP=192.168.22.103
set OPENSSL="C:\Program Files\Git\usr\bin\openssl.exe"

if not exist %OPENSSL% (
    echo OpenSSL не найден по пути %OPENSSL%
    echo Укажи правильный путь к openssl.exe
    pause
    exit /b 1
)

REM Создаём конфиг с SubjectAltName — нужен для Android 11+ и Chrome
echo [req] > ssl.cnf
echo distinguished_name = req_distinguished_name >> ssl.cnf
echo x509_extensions = v3_req >> ssl.cnf
echo prompt = no >> ssl.cnf
echo [req_distinguished_name] >> ssl.cnf
echo CN = %IP% >> ssl.cnf
echo [v3_req] >> ssl.cnf
echo keyUsage = critical, digitalSignature, keyEncipherment >> ssl.cnf
echo extendedKeyUsage = serverAuth >> ssl.cnf
echo subjectAltName = @alt_names >> ssl.cnf
echo [alt_names] >> ssl.cnf
echo IP.1 = %IP% >> ssl.cnf
echo IP.2 = 127.0.0.1 >> ssl.cnf

%OPENSSL% req -x509 -nodes -days 3650 -newkey rsa:2048 ^
  -keyout key.pem ^
  -out cert.pem ^
  -config ssl.cnf

REM Создаём .crt копию для Android
copy cert.pem cert.crt > nul

del ssl.cnf

if %errorlevel% == 0 (
    echo.
    echo ✅ Сертификат создан: cert.pem, key.pem, cert.crt
    echo    cert.crt — установи на Android устройства
) else (
    echo ❌ Ошибка генерации сертификата
)

pause
