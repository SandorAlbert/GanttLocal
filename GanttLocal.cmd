@echo off
rem Opens GanttLocal in its own window. Closing that window stops the server.
cd /d "%~dp0"

where /q pythonw
if %errorlevel%==0 (
  start "" pythonw serve.py --auto-exit --app-window
  exit /b
)

where /q python
if %errorlevel%==0 (
  start "GanttLocal server" /min python serve.py --auto-exit --app-window
  exit /b
)

echo.
echo Python 3 was not found on PATH.
echo Install it from the Microsoft Store or python.org, then run this file again.
pause
