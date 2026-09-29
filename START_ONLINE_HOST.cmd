@echo off
setlocal EnableExtensions
title ASHEN OATH - online duel host (LAN relay)
cd /d "%~dp0"

rem Online duel, LAN mode: starts the game server (new window, opens the browser)
rem and the LAN relay tools\relay.py in this window (port 8790, prints this laptop's IP).
rem Standard Python 3 only. Installs nothing, needs no administrator rights.
rem The second player just runs START_GAME.cmd on their laptop and types the IP shown below.

set "PYEXE="
set "PYFOUND="
for /f "delims=" %%L in ('py -0p 2^>nul ^| findstr /i "python.exe"') do set "PYFOUND=1"
if defined PYFOUND (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>&1
  if not errorlevel 1 set "PYEXE=py -3"
)
if defined PYEXE goto run

python -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>&1
if not errorlevel 1 set "PYEXE=python"
if defined PYEXE goto run

goto nopython

:run
echo Starting the game server in a separate window...
start "ASHEN OATH - local server" %PYEXE% "%~dp0serve_game.py"
echo.
echo Starting the LAN relay. If Windows Firewall asks - allow Python on PRIVATE networks.
echo In the game: Online duel - LAN - the other player types the IP shown below.
echo.
set PYTHONIOENCODING=utf-8
%PYEXE% "%~dp0tools\relay.py" %*
if errorlevel 1 (
  echo.
  echo The relay stopped with an error. See the message above.
  pause
)
goto end

:nopython
echo.
echo ============================================================
echo  Python 3.7+ was not found on this computer.
echo  Install Python 3 from https://www.python.org/downloads/
echo  (tick "Add python.exe to PATH") and run this file again.
echo  Nothing was installed or changed on this computer.
echo ============================================================
echo.
pause

:end
endlocal
