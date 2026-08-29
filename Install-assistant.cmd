@echo off
rem Install Python libraries for optional Chat (CPU).
cd /d "%~dp0"

where /q python
if %errorlevel% neq 0 (
  echo.
  echo Python 3 was not found on PATH.
  echo Install it from the Microsoft Store or python.org, then run this file again.
  pause
  exit /b 1
)

echo Ensuring pip...
python -m ensurepip --upgrade
python -m pip install --upgrade pip
if %errorlevel% neq 0 (
  echo Failed to install or upgrade pip.
  pause
  exit /b 1
)

echo.
echo Installing Python packages from requirements.txt...
python -m pip install -r requirements.txt
set ERR=%ERRORLEVEL%
echo.
if %ERR% neq 0 (
  echo Install failed.
) else (
  echo Python libraries installed.
  echo Next: save the model as llm\models\chat.gguf
)
pause
exit /b %ERR%
