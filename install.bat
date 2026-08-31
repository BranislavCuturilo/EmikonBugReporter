@echo off
setlocal EnableDelayedExpansion
title Emikon Bug Reporter - instalacija
color 0F

set "PS1=%~dp0install.ps1"
set "RAW=https://raw.githubusercontent.com/BranislavCuturilo/EmikonBugReporter/main/install.ps1"

rem Ovaj fajl mora da radi i kada je jedini fajl koji korisnik ima - pre nego
rem sto repozitorijum uopste postoji na disku. Ako install.ps1 nije pored njega,
rem skida ga.
if not exist "%PS1%" (
    echo.
    echo   Preuzimam instalacionu skriptu...
    set "PS1=%TEMP%\ebr-install.ps1"
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "try { Invoke-WebRequest -Uri '%RAW%' -OutFile $env:TEMP'\ebr-install.ps1' -UseBasicParsing; exit 0 } catch { exit 1 }"
    if errorlevel 1 (
        echo.
        echo   Preuzimanje nije uspelo.
        echo   Proveri internet vezu, ili skini ceo repozitorijum rucno sa:
        echo   https://github.com/BranislavCuturilo/EmikonBugReporter
        echo.
        pause
        exit /b 1
    )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo   Instalacija je prekinuta ^(kod %RC%^).
    pause
)
exit /b %RC%
