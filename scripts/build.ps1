#Requires -Version 5.1
<#
.SYNOPSIS
  Собирает DnD-Tablet в dist/ для Windows, Linux и macOS.

.DESCRIPTION
  dist/ каждый запуск пересоздаётся с нуля.
  Windows собирается локально (cargo + gcc из w64devkit), Linux и macOS — тем же
  скриптом через GitHub Actions: он запускает workflow build-all.yml через gh CLI,
  дожидается сборки и складывает бинарники в dist/ вместе с run.bat/install.bat,
  README, CHANGELOG и SHA256SUMS.txt.

  Для Linux/macOS один раз нужны: GitHub CLI (winget install --id GitHub.cli)
  и вход в аккаунт с правом запускать Actions (gh auth login).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build.ps1

.EXAMPLE
  pwsh scripts/build.ps1 -Platforms windows -NoTests   # только локальный Windows
#>
[CmdletBinding()]
param(
    [ValidateSet('windows', 'linux', 'macos')]
    [string[]]$Platforms = @('windows', 'linux', 'macos'),
    [string]$Version = '',
    [switch]$NoTests,
    [int]$CiTimeoutMinutes = 30
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    function Step($text) { Write-Host "== $text" -ForegroundColor Cyan }
    function Die($text) { Write-Host "!! $text" -ForegroundColor Red; exit 1 }

    # cargo пишет прогресс в stderr; при ErrorActionPreference=Stop PowerShell 5.1
    # считает это ошибкой и обрывает скрипт. На время вызова гасим строгий режим.
    function Invoke-Cargo([string[]]$CargoArgs) {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & cargo @CargoArgs 2>&1 | ForEach-Object { Write-Host $_ } }
        finally { $ErrorActionPreference = $previous }
    }

    # --- версия ---
    $line = (Select-String -Path 'Cargo.toml' -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1)
    if (-not $line) { Die 'В Cargo.toml не найдено поле version.' }
    $cargoVersion = $line.Matches[0].Groups[1].Value
    if (-not $Version) { $Version = $cargoVersion }
    if ($Version -ne $cargoVersion) { Die "Версия $Version не совпадает с Cargo.toml ($cargoVersion)." }

    $needWindows = $Platforms -contains 'windows'
    $needCi = ($Platforms -contains 'linux') -or ($Platforms -contains 'macos')

    # Для Linux/macOS сборка идёт через GitHub Actions — проверяем это до того,
    # как трогать dist/, чтобы неудачный запуск не оставлял половину комплекта.
    if ($needCi) {
        if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
            Die ('Для Linux/macOS нужен GitHub CLI: winget install --id GitHub.cli, затем gh auth login. ' +
                 'Либо соберите только Windows: -Platforms windows.')
        }
        & gh auth status 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Die 'gh не авторизован: выполните gh auth login (нужно право запускать Actions).' }
    }

    # --- dist всегда с нуля ---
    $dist = Join-Path $root 'dist'
    $before = if (Test-Path $dist) { (Get-ChildItem $dist -Recurse -File | Measure-Object).Count } else { 0 }
    Step "пересоздаю dist/ (было файлов: $before)"
    if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dist | Out-Null

    # --- тулчейн: GNU-линкеру нужен gcc (MSVC-сборка в этом окружении недоступна) ---
    if ($needWindows) {
        if (-not (Get-Command gcc -ErrorAction SilentlyContinue)) {
            foreach ($dir in @("$env:USERPROFILE\tools\w64devkit\bin", 'C:\Users\dimon\tools\w64devkit\bin')) {
                if (Test-Path (Join-Path $dir 'gcc.exe')) { $env:Path = "$dir;$env:Path"; break }
            }
        }
        if (-not (Get-Command gcc -ErrorAction SilentlyContinue)) {
            Die 'Не найден gcc. Установите w64devkit и добавьте его bin в PATH (или задайте toolchain в rust-toolchain.toml).'
        }
    }

    # --- тесты (один раз; -NoTests для быстрой сборки) ---
    if (-not $NoTests) {
        Step 'cargo test'
        Invoke-Cargo 'test', '--quiet'
        if ($LASTEXITCODE -ne 0) { Die 'cargo test завершился с ошибкой.' }
    }

    # --- Windows: локальная сборка ---
    if ($needWindows) {
        Step "cargo build --release (windows, версия $Version)"
        Invoke-Cargo 'build', '--release'
        if ($LASTEXITCODE -ne 0) { Die 'cargo build --release завершился с ошибкой.' }
        $exe = Join-Path $root 'target\release\dnd-table.exe'
        if (-not (Test-Path $exe)) { Die "Не найден бинарник: $exe" }
        Copy-Item $exe (Join-Path $dist 'dnd-table-windows-x86_64.exe')
        Copy-Item $exe (Join-Path $dist 'dnd-table.exe')
    }

    # --- Linux/macOS: CI через gh CLI ---
    if ($needCi) {

        Step 'запускаю CI-сборку build-all.yml'
        & gh workflow run build-all.yml 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { Die 'Не удалось запустить build-all.yml.' }

        $runId = $null
        for ($i = 0; $i -lt 30 -and -not $runId; $i++) {
            Start-Sleep -Seconds 2
            $json = & gh run list --workflow build-all.yml --limit 1 --json databaseId 2>$null
            if ($LASTEXITCODE -eq 0 -and $json) {
                $run = $json | ConvertFrom-Json
                if ($run) { $runId = $run[0].databaseId }
            }
        }
        if (-not $runId) { Die 'Запуск build-all.yml не появился за минуту.' }

        Step "жду сборку CI (run $runId, до $CiTimeoutMinutes мин)"
        $deadline = (Get-Date).AddMinutes($CiTimeoutMinutes)
        while ((Get-Date) -lt $deadline) {
            $json = & gh run view $runId --json status,conclusion 2>$null
            if ($LASTEXITCODE -eq 0 -and $json) {
                $state = $json | ConvertFrom-Json
                if ($state.status -eq 'completed') {
                    if ($state.conclusion -ne 'success') { Die "CI-сборка завершилась: $($state.conclusion)." }
                    break
                }
            }
            Start-Sleep -Seconds 10
        }
        if ((Get-Date) -ge $deadline) { Die 'CI-сборка не уложилась в таймаут.' }

        Step 'скачиваю артефакты Linux/macOS'
        $ciDir = Join-Path $dist '.ci'
        & gh run download $runId -D $ciDir 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { Die 'Не удалось скачать артефакты CI.' }

        foreach ($asset in @('dnd-table-linux-x86_64', 'dnd-table-macos-aarch64')) {
            $file = Get-ChildItem $ciDir -Recurse -File -Filter $asset | Select-Object -First 1
            if (-not $file) { Die "В артефактах CI нет $asset." }
            Copy-Item $file.FullName (Join-Path $dist $asset)
        }
        Remove-Item $ciDir -Recurse -Force
    }

    # --- сопроводительные файлы и контрольные суммы ---
    foreach ($file in @('run.bat', 'install.bat', 'README.md', 'CHANGELOG.md')) {
        if (Test-Path $file) { Copy-Item $file (Join-Path $dist $file) }
    }

    foreach ($file in @('run.bat', 'install.bat')) {
        $path = Join-Path $dist $file
        if (-not (Test-Path $path)) { continue }
        $bytes = [IO.File]::ReadAllBytes($path)
        for ($i = 0; $i -lt $bytes.Length; $i++) {
            if ($bytes[$i] -gt 127) { Die "$file должен быть ASCII (байт $i = $($bytes[$i]))." }
            if ($bytes[$i] -eq 10 -and ($i -eq 0 -or $bytes[$i - 1] -ne 13)) { Die "$file должен использовать CRLF (голый LF в байте $i)." }
        }
    }

    $sums = New-Object System.Collections.Generic.List[string]
    foreach ($file in Get-ChildItem $dist -File | Sort-Object Name) {
        $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $sums.Add("$hash  $($file.Name)")
    }
    [IO.File]::WriteAllLines((Join-Path $dist 'SHA256SUMS.txt'), $sums, [Text.UTF8Encoding]::new($false))

    Write-Host ''
    Write-Host "Готово: dist/ (версия $Version, платформы: $($Platforms -join ', '))" -ForegroundColor Green
    Get-ChildItem $dist -File | Sort-Object Name | ForEach-Object {
        Write-Host ("  {0,-34} {1,8:N1} МБ" -f $_.Name, ($_.Length / 1MB))
    }
    Write-Host ''
    Write-Host 'Пуш и теги скрипт не делает: для релиза поднимите version в Cargo.toml и поставьте тег v<версия>.'
}
finally {
    Pop-Location
}