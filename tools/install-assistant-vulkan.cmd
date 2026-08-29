@echo off
REM Thin wrapper. Prefer:  python tools\install_assistant.py vulkan
cd /d "%~dp0.."
python tools\install_assistant.py vulkan
exit /b %ERRORLEVEL%
