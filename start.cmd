@echo off
cd /d "%~dp0"

where /q py
if %errorlevel%==0 (
  py -3 serve.py %*
  goto :eof
)

where /q python
if %errorlevel%==0 (
  python serve.py %*
  goto :eof
)

echo.
echo Python 3 was not found on PATH.
echo Install it from the Microsoft Store or python.org, then run this file again.
pause
