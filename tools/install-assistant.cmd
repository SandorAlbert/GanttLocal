@echo off
REM Thin wrapper. Prefer:  python tools\install_assistant.py
cd /d "%~dp0.."
python tools\install_assistant.py cpu
exit /b %ERRORLEVEL%
