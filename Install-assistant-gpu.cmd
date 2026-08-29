@echo off
rem Install Python libraries for optional Chat, then the Vulkan GPU wheel.
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
  echo Failed to install pip.
  pause
  exit /b 1
)

echo.
echo Installing Python packages from requirements.txt...
python -m pip install -r requirements.txt
if %errorlevel% neq 0 (
  echo Install failed.
  pause
  exit /b 1
)

echo.
echo Installing Vulkan GPU wheel for llama-cpp-python...
python -m pip install llama-cpp-python --force-reinstall --no-cache-dir --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/vulkan
set ERR=%ERRORLEVEL%
echo.
if %ERR% neq 0 (
  echo GPU wheel install failed. CPU packages from requirements.txt are already in place.
) else (
  echo Python libraries installed ^(Vulkan GPU^).
  echo Next: save the model as llm\models\chat.gguf
  echo In GanttLocal: Settings ^> Assistant ^> Use GPU.
)
pause
exit /b %ERR%
