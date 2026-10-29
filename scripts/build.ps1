#Requires -Version 5.1
<#
.SYNOPSIS
  Собирает Windows-релиз DnD-Tablet в dist/.

.DESCRIPTION
  Один скрипт вместо ручной сборки: берёт версию из Cargo.toml, при необходимости
  прогоняет тесты, собирает release-бинарь, складывает рядом run.bat, install.bat,
  README.md и CHANGELOG.md, упаковывает в DnD-Tablet-<версия>-win64.zip и пишет
  SHA256SUMS.txt. Ничего не коммитит и не пушит.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build.ps1

.EXAMPLE
  pwsh scripts/build.ps1 -NoTests -NoZip      # быстрая сборка только exe
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [switch]$NoTests,
    [switch]$NoZip,
    [switch]$Clean,
    [switch]$Smoke
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

    # --- тулчейн: GNU-линкеру нужен gcc (MSVC-сборка в этом окружении недоступна) ---
    if (-not (Get-Command gcc -ErrorAction SilentlyContinue)) {
        foreach ($dir in @("$env:USERPROFILE\tools\w64devkit\bin", 'C:\Users\dimon\tools\w64devkit\bin')) {
            if (Test-Path (Join-Path $dir 'gcc.exe')) { $env:Path = "$dir;$env:Path"; break }
        }
    }
    if (-not (Get-Command gcc -ErrorAction SilentlyContinue)) {
        Die 'Не найден gcc. Установите w64devkit и добавьте его bin в PATH (или задайте toolchain в rust-toolchain.toml).'
    }

    # --- тесты (по умолчанию; -NoTests для быстрой сборки) ---
    if (-not $NoTests) {
        Step 'cargo test'
        Invoke-Cargo 'test', '--quiet'
        if ($LASTEXITCODE -ne 0) { Die 'cargo test завершился с ошибкой.' }
    }

    # --- сборка ---
    Step "cargo build --release (версия $Version)"
    Invoke-Cargo 'build', '--release'
    if ($LASTEXITCODE -ne 0) { Die 'cargo build --release завершился с ошибкой.' }
    $exe = Join-Path $root 'target\release\dnd-table.exe'
    if (-not (Test-Path $exe)) { Die "Не найден бинарник: $exe" }

    # --- staging ---
    $dist = Join-Path $root 'dist'
    $name = "DnD-Tablet-$Version-win64"
    $stage = Join-Path $dist $name
    $zip = "$stage.zip"
    if ($Clean -and (Test-Path $dist)) { Remove-Item $dist -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    if (Test-Path $zip) { Remove-Item $zip -Force }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    # Старый макет держал README/батники в корне dist — убираем, чтобы не путали с новым комплектом.
    foreach ($stale in @('run.bat', 'install.bat', 'README.md', 'CHANGELOG.md', 'config.yml')) {
        $old = Join-Path $dist $stale
        if (Test-Path $old) { Remove-Item $old -Force }
    }

    Step "staging: dist\$name"
    Copy-Item $exe (Join-Path $stage 'dnd-table.exe')
    foreach ($file in @('run.bat', 'install.bat', 'README.md', 'CHANGELOG.md', 'config.yml')) {
        if (Test-Path $file) { Copy-Item $file (Join-Path $stage $file) }
    }

    # Батники уходят пользователю как есть — cmd.exe требует ASCII и CRLF (как в CI).
    foreach ($file in @('run.bat', 'install.bat')) {
        $path = Join-Path $stage $file
        if (-not (Test-Path $path)) { continue }
        $bytes = [IO.File]::ReadAllBytes($path)
        for ($i = 0; $i -lt $bytes.Length; $i++) {
            if ($bytes[$i] -gt 127) { Die "$file должен быть ASCII (байт $i = $($bytes[$i]))." }
            if ($bytes[$i] -eq 10 -and ($i -eq 0 -or $bytes[$i - 1] -ne 13)) { Die "$file должен использовать CRLF (голый LF в байте $i)." }
        }
    }

    # --- архив ---
    if (-not $NoZip) {
        Step "zip: dist\$name.zip"
        Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
    }

    # --- контрольные суммы и копия exe в корень dist ---
    Copy-Item $exe (Join-Path $dist 'dnd-table.exe') -Force
    $sums = New-Object System.Collections.Generic.List[string]
    foreach ($path in @($exe, $zip)) {
        if (Test-Path $path) {
            $hash = (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
            $sums.Add("$hash  $([IO.Path]::GetFileName($path))")
        }
    }
    [IO.File]::WriteAllLines((Join-Path $dist 'SHA256SUMS.txt'), $sums, [Text.UTF8Encoding]::new($false))

    # --- необязательный дымовой прогон на собранном бинаре ---
    if ($Smoke) {
        $bash = Get-Command bash -ErrorAction SilentlyContinue
        if ($bash) {
            Step 'smoke.sh'
            & $bash.Source 'scripts/smoke.sh' 'target/release/dnd-table.exe'
            if ($LASTEXITCODE -ne 0) { Die 'smoke.sh завершился с ошибкой.' }
        } else {
            Write-Host '!! bash не найден — smoke пропущен.' -ForegroundColor Yellow
        }
    }

    # --- итог ---
    $exeSize = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    Write-Host ''
    Write-Host "Готово: $name" -ForegroundColor Green
    Write-Host "  exe : dist\dnd-table.exe ($exeSize МБ, версия $Version)"
    if (Test-Path $zip) {
        $zipSize = [math]::Round((Get-Item $zip).Length / 1MB, 1)
        Write-Host "  zip : dist\$name.zip ($zipSize МБ)"
    }
    Write-Host "  sums: dist\SHA256SUMS.txt"
    Write-Host ''
    Write-Host 'Пуш и теги скрипт не делает: для релиза поднимите version в Cargo.toml и поставьте тег v<версия>.'
}
finally {
    Pop-Location
}
