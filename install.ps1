<#
  Emikon Bug Reporter - instalacija.

  Radi sve sto se moze automatizovati. Jednu stvar NE moze, i to nije propust
  skripte: Chrome ne dozvoljava da bilo koji program instalira raspakovanu
  ekstenziju. Nema API, nema komandnu liniju, nema registry trik koji to radi
  bez enterprise politike i potpisanog CRX-a. Zato skripta pripremi bukvalno
  sve i ostavi coveku jedan klik, sa uputstvom na ekranu.

  Ne trazi administratorska prava: sve ide u %LOCALAPPDATA%.
#>

[CmdletBinding()]
param(
    [string]$Repo    = "https://github.com/BranislavCuturilo/EmikonBugReporter.git",
    [string]$Branch  = "main",
    [string]$Dir     = "$env:LOCALAPPDATA\EmikonBugReporter",
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$script:StepNo = 0

function Write-Step {
    param([string]$Text)
    $script:StepNo++
    Write-Host ""
    Write-Host ("[{0}] {1}" -f $script:StepNo, $Text) -ForegroundColor Cyan
}
function Write-Ok   { param([string]$t) Write-Host "    OK  $t" -ForegroundColor Green }
function Write-Warn { param([string]$t) Write-Host "    !   $t" -ForegroundColor Yellow }
function Write-Bad  { param([string]$t) Write-Host "    X   $t" -ForegroundColor Red }

function Refresh-Path {
    # Posle instalacije gita PATH u OVOJ sesiji je i dalje stari, pa bi provera
    # odmah posle instalacije pogresno rekla da git ne postoji.
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = ($machine, $user | Where-Object { $_ }) -join ";"
}

function Wait-Enter {
    <#
      Drzi prozor otvorenim kad korisnik dvoklikne skriptu. Kad se pokrece
      neinteraktivno (test, CI), Read-Host cita EOF i puca - a skripta koja
      pukne na kraju uspesnog posla prijavljuje lazan neuspeh.
    #>
    param([string]$Prompt = "  Enter za izlaz")
    try { Read-Host $Prompt | Out-Null } catch { Write-Host "" }
}

function Invoke-Git {
    <#
      Git pise napomene na stderr i kad je sve u redu, a PowerShell 5.1 svaki
      takav red pretvara u NativeCommandError. Zato se poziva ovako: izlaz se
      hvata u promenljivu i pokazuje SAMO ako komanda stvarno padne, i to tek
      posle nase razumljive poruke. Korisnik ne treba da cita git.
    #>
    param([Parameter(Mandatory=$true)][string[]]$GitArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out  = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    return [pscustomobject]@{ Code = $code; Output = ($out | Out-String).Trim() }
}

function Test-Command {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host ""
Write-Host "  Emikon Bug Reporter" -ForegroundColor White
Write-Host "  instalacija Chrome ekstenzije" -ForegroundColor DarkGray
Write-Host "  --------------------------------------------------" -ForegroundColor DarkGray

# ---------------------------------------------------------------- git --------
Write-Step "Proveravam da li je Git instaliran"

if (Test-Command git) {
    Write-Ok ((git --version) -join "")
} else {
    Write-Warn "Git nije pronadjen - instaliram ga"

    $installed = $false
    if (Test-Command winget) {
        Write-Host "    ...preko winget-a, ovo traje minut-dva" -ForegroundColor DarkGray
        # --scope user: bez administratorskih prava
        winget install --id Git.Git --source winget --scope user `
                       --accept-package-agreements --accept-source-agreements `
                       --silent | Out-Null
        Refresh-Path
        $installed = Test-Command git
    }

    if (-not $installed) {
        Write-Warn "winget nije uspeo - skidam zvanicni instalater"
        $url = "https://github.com/git-for-windows/git/releases/latest/download/Git-2.51.0-64-bit.exe"
        $exe = Join-Path $env:TEMP "git-installer.exe"
        try {
            Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
            Start-Process -FilePath $exe -ArgumentList "/VERYSILENT","/NORESTART" -Wait
            Refresh-Path
            $installed = Test-Command git
        } catch {
            Write-Bad "Skidanje nije uspelo: $($_.Exception.Message)"
        }
    }

    if (-not $installed) {
        Write-Bad "Git i dalje nije dostupan."
        Write-Host ""
        Write-Host "    Instaliraj ga rucno sa https://git-scm.com/download/win" -ForegroundColor Yellow
        Write-Host "    pa pokreni ovu skriptu ponovo." -ForegroundColor Yellow
        Wait-Enter "`n    Enter za izlaz"
        exit 1
    }
    Write-Ok "Git instaliran"
}

# --------------------------------------------------------------- kod ---------
Write-Step "Preuzimam ekstenziju u $Dir"

if (Test-Path (Join-Path $Dir ".git")) {
    Write-Host "    ...vec postoji, azuriram na najnovije" -ForegroundColor DarkGray
    Push-Location $Dir
    try {
        # Ogledalo, ne spajanje: instalacioni folder nikad nema sopstvene
        # commit-ove, pa reset sam sebe popravlja iz bilo kakve razlike.
        $r = Invoke-Git @("fetch", "--quiet", "origin", $Branch)
        if ($r.Code -ne 0) { throw "Preuzimanje izmena nije uspelo.`n$($r.Output)" }
        $r = Invoke-Git @("reset", "--hard", "--quiet", "origin/$Branch")
        if ($r.Code -ne 0) { throw "Postavljanje na najnoviju verziju nije uspelo.`n$($r.Output)" }
        $ver = (Get-Content (Join-Path $Dir "manifest.json") -Raw | ConvertFrom-Json).version
        Write-Ok "Azurirano na v$ver"
    } finally {
        Pop-Location
    }
} else {
    if (Test-Path $Dir) {
        # Folder postoji ali nije git repo - ne brisemo tudje fajlove nemo
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backup = "$Dir.staro-$stamp"
        Write-Warn "Folder postoji a nije git repo - premestam ga u $backup"
        Move-Item -Path $Dir -Destination $backup
    }
    $r = Invoke-Git @("clone", "--quiet", "--branch", $Branch, "--depth", "1", $Repo, $Dir)
    if ($r.Code -ne 0 -or -not (Test-Path (Join-Path $Dir "manifest.json"))) {
        Write-Bad "Preuzimanje nije uspelo."
        Write-Host ""
        Write-Host "    Najcesci razlog: repozitorijum je privatan ili ne postoji." -ForegroundColor Yellow
        Write-Host "    Adresa koja je pokusana:" -ForegroundColor Yellow
        Write-Host "      $Repo" -ForegroundColor White
        Write-Host ""
        Write-Host "    Otvori tu adresu u browseru. Ako trazi prijavu ili javlja 404," -ForegroundColor DarkGray
        Write-Host "    repozitorijum nije javan i instalacija ne moze da ga preuzme." -ForegroundColor DarkGray
        if ($r.Output) {
            Write-Host ""
            Write-Host "    (tehnicki detalj: $($r.Output -split "`n" | Select-Object -Last 1))" -ForegroundColor DarkGray
        }
        Wait-Enter "`n    Enter za izlaz"
        exit 1
    }
    $ver = (Get-Content (Join-Path $Dir "manifest.json") -Raw | ConvertFrom-Json).version
    Write-Ok "Preuzeto, verzija v$ver"
}

# ------------------------------------------------------------ chrome ---------
Write-Step "Trazim Chrome"

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) { Write-Ok "Chrome: $chrome" }
else         { Write-Warn "Chrome nije nadjen na uobicajenim mestima - otvori ga rucno" }

# ------------------------------------------------------------ uputstvo -------
try {
    Set-Clipboard -Value $Dir
    $clip = "  (putanja je vec u clipboard-u - samo Ctrl+V)"
} catch {
    $clip = ""
}

Write-Host ""
Write-Host "  --------------------------------------------------" -ForegroundColor DarkGray
Write-Host "  Ostao je JEDAN korak koji Chrome trazi od coveka" -ForegroundColor White
Write-Host "  --------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Chrome namerno ne dozvoljava nijednom programu da sam" -ForegroundColor DarkGray
Write-Host "  ubaci ekstenziju - to je zastita, ne greska ove skripte." -ForegroundColor DarkGray
Write-Host ""
Write-Host "   1. Otvorice se stranica  chrome://extensions" -ForegroundColor White
Write-Host "   2. Gore desno ukljuci    Developer mode" -ForegroundColor White
Write-Host "   3. Klikni                Load unpacked" -ForegroundColor White
Write-Host "   4. Nalepi putanju:" -ForegroundColor White
Write-Host "      $Dir" -ForegroundColor Yellow
Write-Host "     $clip" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Posle toga klikni ikonicu ekstenzije pa zupcanik i unesi" -ForegroundColor DarkGray
Write-Host "  helpdesk token i Gemini kljuc." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Ovo se radi SAMO PRVI PUT. Kasnija azuriranja idu preko" -ForegroundColor DarkGray
Write-Host "  update.bat i ne traze nista od tebe." -ForegroundColor DarkGray
Write-Host ""

if ($chrome -and -not $NoLaunch) {
    Wait-Enter "  Enter da otvorim chrome://extensions"
    Start-Process -FilePath $chrome -ArgumentList "chrome://extensions"
} else {
    Wait-Enter "  Enter za izlaz"
}
