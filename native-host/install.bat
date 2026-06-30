@echo off
setlocal enabledelayedexpansion

echo ============================================
echo   M3U8 Sniffer - Native Host Installer
echo ============================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)

where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] ffmpeg not found. MP4 merge will NOT work.
    echo.
)

set "HOST_DIR=%~dp0"
if "%HOST_DIR:~-1%"=="\" set "HOST_DIR=%HOST_DIR:~0,-1%"

for /f "tokens=*" %%i in ('where node 2^>nul') do set "NODE_PATH=%%i"

echo [INFO] Node.js  : !NODE_PATH!
echo [INFO] Host dir : !HOST_DIR!

set "LAUNCHER=!HOST_DIR!\host_launcher.bat"
set "HOST_SCRIPT=!HOST_DIR!\host.js"
(
echo @echo off
echo "!NODE_PATH!" "!HOST_SCRIPT!"
) > "!LAUNCHER!"

echo [INFO] Launcher created: !LAUNCHER!

REM Read previously saved extension ID
set "ID_FILE=!HOST_DIR!\extension_id.txt"
set "SAVED_ID="
if exist "!ID_FILE!" set /p SAVED_ID=<"!ID_FILE!"

echo.
if not "!SAVED_ID!"=="" (
    echo Saved extension ID: !SAVED_ID!
    echo Press Enter to keep, or type a new one to update:
) else (
    echo Enter the extension ID from chrome://extensions/:
)
set /p INPUT_ID="Extension ID: "

if not "!INPUT_ID!"=="" (
    set "EXT_ID=!INPUT_ID!"
    echo !INPUT_ID!>"!ID_FILE!"
    echo [OK] ID saved to extension_id.txt
) else if not "!SAVED_ID!"=="" (
    set "EXT_ID=!SAVED_ID!"
) else (
    echo [ERROR] No extension ID provided.
    pause
    exit /b 1
)

REM Write manifest
set "MANIFEST=!HOST_DIR!\com.m3u8.sniffer.json"
(
echo {
echo   "name": "com.m3u8.sniffer",
echo   "description": "M3U8 Sniffer Native Messaging Host",
echo   "path": "!LAUNCHER:\=\\!",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://!EXT_ID!/"
echo   ]
echo }
) > "!MANIFEST!"

echo [OK] Manifest written: !MANIFEST!

echo.
echo [INFO] Registering in Windows Registry...
echo.

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.m3u8.sniffer" /ve /t REG_SZ /d "!MANIFEST:\=\\!" /f >nul 2>&1
if !errorlevel! equ 0 (echo [OK] Chrome registered) else (echo [WARN] Chrome registration failed)

reg add "HKCU\Software\Chromium\NativeMessagingHosts\com.m3u8.sniffer" /ve /t REG_SZ /d "!MANIFEST:\=\\!" /f >nul 2>&1
if !errorlevel! equ 0 (echo [OK] Chromium registered) else (echo [INFO] Chromium skipped)

echo.
echo ============================================
echo   Done!
echo ============================================
echo Manifest: !MANIFEST!
echo Extension ID: !EXT_ID!
echo.
pause
endlocal
