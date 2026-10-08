@echo off
rem Start NEXUS AI on Windows - backend and frontend together, in this one window.
rem
rem   start.bat            then open http://localhost:3000
rem   start.bat --lan      also reachable from other devices on your network
rem
rem The servers run inside WSL2 (Linux on Windows): Windows Smart App Control blocks the
rem unsigned compiled Python packages the backend needs, so it cannot run natively.
rem scripts\wsl-start.sh does the Linux side: it installs Node.js and uv there on the
rem first run, copies this folder to a run copy on the Linux filesystem and runs
rem start.sh. Logs from both servers appear here, prefixed [api] and [web]. Press Ctrl-C,
rem or close this window, to stop both.
setlocal EnableExtensions
title NEXUS AI
cd /d "%~dp0"

where wsl.exe >nul 2>&1 || goto no_wsl
rem Without WSL, wsl.exe waits for a key press ("Press any key to install"); with its
rem output hidden that is a black window, so give it no keyboard to wait for.
wsl.exe -e bash -c true <nul >nul 2>&1 || goto no_wsl

rem --- LAN mode -----------------------------------------------------------------
rem Other devices see this PC, not the Linux machine inside it, so pass the Windows
rem addresses along (scripts/dev.sh reads NEXUS_LAN_HOSTS; WSLENV carries it into WSL).
set "LAN=0"
if "%NEXUS_LAN%"=="1" set "LAN=1"
for %%a in (%*) do if /i "%%~a"=="--lan" set "LAN=1"
if not "%LAN%"=="1" goto lan_done
set "NEXUS_LAN_HOSTS="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual).IPAddress -join ' '"`) do set "NEXUS_LAN_HOSTS=%%i"
set "WSLENV=NEXUS_LAN_HOSTS:%WSLENV%"
echo LAN mode: other devices can only connect if WSL uses mirrored networking. Put
echo   [wsl2]
echo   networkingMode=mirrored
echo in %USERPROFILE%\.wslconfig, run "wsl --shutdown", then start again.
echo.
:lan_done

rem --- Run ----------------------------------------------------------------------
rem The script is read through tr so Windows line endings in it can never break bash.
wsl.exe -e bash -c "exec bash <(tr -d '\r' < scripts/wsl-start.sh) %*"

echo.
echo NEXUS AI has stopped.
pause
exit /b 0

rem --- WSL is missing -----------------------------------------------------------
:no_wsl
echo NEXUS AI runs inside WSL2 (Linux on Windows) on this PC, because Windows Smart App
echo Control blocks the Python packages the backend needs. WSL2 is not set up yet.
echo.
where wsl.exe >nul 2>&1 || goto no_wsl_manual
choice /c YN /m "Install WSL2 with Ubuntu now (Windows asks for administrator rights)"
if errorlevel 2 goto no_wsl_manual
powershell -NoProfile -Command "Start-Process cmd.exe -ArgumentList '/k wsl.exe --install -d Ubuntu' -Verb RunAs"
if errorlevel 1 goto no_wsl_manual
echo.
echo A second window is installing WSL2. When it has finished:
echo   1. Restart Windows.
echo   2. Open "Ubuntu" from the Start menu once and choose a Linux user name and password.
echo   3. Run start.bat again.
goto fail

:no_wsl_manual
echo To install it yourself: open a terminal as administrator and run
echo   wsl --install -d Ubuntu
echo then restart Windows, open "Ubuntu" once to create your Linux user, and run start.bat again.
goto fail

:fail
echo.
echo NEXUS AI did not start. See the message above.
pause
exit /b 1
