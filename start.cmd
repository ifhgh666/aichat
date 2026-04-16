@echo off
cd /d "%~dp0"
node app.js
if errorlevel 1 pause
