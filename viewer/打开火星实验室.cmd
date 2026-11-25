@echo off
setlocal
cd /d "%~dp0"
if not exist "dist\index.html" (
  node scripts\build.mjs
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
start "" "%~dp0dist\index.html"
