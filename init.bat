@echo off
:: Check for administrative permissions
net session >nul 2>&1
if %errorLevel% == 0 (
    echo Administrative permissions confirmed.
) else (
    echo Requesting administrative privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo Initializing LiveSuite project for Windows...

:: 1. Initialize and update git submodules
echo Updating git submodules...
git submodule update --init --recursive
if %errorlevel% neq 0 (
    echo Error: Failed to update git submodules.
    pause
    exit /b %errorlevel%
)

:: 2. Ensure subbuild directory is ready
set "SUB_DIR=udp"
set "TARGET_LINK=subbuild"

echo Checking submodule directory: %SUB_DIR%...
if not exist "%SUB_DIR%" (
    echo Error: Submodule directory "%SUB_DIR%" not found.
    pause
    exit /b 1
)

:: 3. Create symbolic link
echo Creating symbolic link: %TARGET_LINK% -> %SUB_DIR%
if exist "%TARGET_LINK%" (
    echo Removing existing %TARGET_LINK%...
    rmdir /s /q "%TARGET_LINK%"
)

mklink /d "%TARGET_LINK%" "%SUB_DIR%"
if %errorlevel% neq 0 (
    echo Error: Failed to create symbolic link.
    pause
    exit /b %errorlevel%
)

echo Initialization complete.
pause
