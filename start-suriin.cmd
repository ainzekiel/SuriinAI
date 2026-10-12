@echo off
cd /d "%~dp0"
echo Starting Suriin AI. Open http://127.0.0.1:5000/ after the server is ready.
echo The first startup may take a moment while the detection model loads.
if not exist ".venv\Scripts\python.exe" (
  echo Project Python environment is missing. Set up .venv first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" "web-application\app.py"
pause
