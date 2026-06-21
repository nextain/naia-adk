@echo off
echo Starting Naia ADK...
echo.
echo   Server:    http://localhost:3141
echo   Dashboard: http://localhost:3142
echo.
cd /d "%~dp0"
pnpm dev
