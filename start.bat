@echo off
echo Starting Naia ADK...
echo.
echo   Server:    http://localhost:3141
echo   Dashboard: http://localhost:3142
echo   Docs:      http://localhost:3142/docs
echo   Docs/Work: http://localhost:3142/docs  (work board: /work)
echo.
cd /d "%~dp0"
pnpm dev
