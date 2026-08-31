@echo off
setlocal
title Emikon Bug Reporter - azuriranje
color 0F

echo.
echo   Emikon Bug Reporter - azuriranje
echo   --------------------------------------------------
echo.

rem Instalacioni folder je OGLEDALO repozitorijuma: nikad nema sopstvene
rem izmene, pa se azurira mirror-ovanjem (fetch + reset), ne spajanjem.
rem Spajanje bi trazilo od korisnika da resava konflikt koji ne razume.
rem
rem Podesavanja se NE diraju: token, skillovi i pravila zive u Chrome-ovom
rem skladistu vezanom za ID ekstenzije, a ne u ovim fajlovima.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$dir = Split-Path -Parent '%~f0';" ^
  "if (-not (Test-Path (Join-Path $dir '.git'))) { Write-Host '   Ovaj folder nije git repozitorijum - pokreni install.bat.' -ForegroundColor Red; exit 2 };" ^
  "Push-Location $dir;" ^
  "$before = (Get-Content (Join-Path $dir 'manifest.json') -Raw | ConvertFrom-Json).version;" ^
  "Write-Host ('   Trenutna verzija: v' + $before);" ^
  "git fetch --quiet origin main;" ^
  "git reset --hard --quiet origin/main;" ^
  "$after = (Get-Content (Join-Path $dir 'manifest.json') -Raw | ConvertFrom-Json).version;" ^
  "Pop-Location;" ^
  "if ($before -eq $after) { Write-Host ('   Vec je najnovija verzija (v' + $after + ').') -ForegroundColor Green }" ^
  "else { Write-Host ('   Azurirano: v' + $before + ' -> v' + $after) -ForegroundColor Green };" ^
  "Write-Host '';" ^
  "Write-Host '   Ostaje jos jedno: otvori chrome://extensions i klikni' -ForegroundColor Yellow;" ^
  "Write-Host '   dugme za osvezavanje na kartici Emikon Bug Reporter.' -ForegroundColor Yellow;" ^
  "Write-Host '   Podesavanja i skillovi su netaknuti.' -ForegroundColor DarkGray;"

set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
