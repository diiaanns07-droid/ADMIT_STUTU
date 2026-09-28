@echo off
setlocal EnableExtensions
title ASHEN OATH - local server
cd /d "%~dp0"

rem Finds a standard Python 3 (py launcher first, then python), runs serve_game.py.
rem Installs nothing, needs no administrator rights, does not touch PowerShell policy.

rem The py launcher is used only if it already lists an installed Python 3
rem (a bare "py -3" may trigger the Python Install Manager to download one).
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
echo Starting ASHEN OATH with: %PYEXE%
echo The browser will open automatically. Keep this window open while playing.
echo.
%PYEXE% "%~dp0serve_game.py" %*
if errorlevel 1 (
  echo.
  echo The server stopped with an error. See the message above.
  pause
)
goto end

:nopython
echo.
echo ============================================================
echo  Python 3.7+ was not found on this computer.
echo.
echo  ASHEN OATH needs standard Python 3 only to run a tiny local
echo  web server (the camera works only over localhost or https).
echo.
echo  1. Install Python 3 from https://www.python.org/downloads/
echo     (tick "Add python.exe to PATH" during setup).
echo  2. Run START_GAME.cmd again.
echo.
echo  Nothing was installed or changed on this computer.
echo ============================================================
echo.
pause

:end
endlocal
