<#
    砚池 (Inkwell) —— Windows 端一键出包脚本

    产物：NSIS 安装包（target/release/bundle/nsis/Inkwell_<版本>_x64-setup.exe）

    用法（普通 PowerShell 即可，无需管理员）：
        powershell -ExecutionPolicy Bypass -File .\personal\scripts\build-win.ps1

    参数：
        -DevBuild       出调试包（编译更快，带 devtools）
        -SkipChecks     跳过环境自检（已确认环境没问题时用，省时间）

    注意：Tauri CLI 必须经 personal/scripts/tauri.mjs 调用，
          不要直接用 @tauri-apps/cli/tauri.js（宿主 argv 探测会误判）。
#>

[CmdletBinding()]
param(
    [switch]$DevBuild,
    [switch]$SkipChecks
)

$ErrorActionPreference = 'Continue'

function Write-Head($t) {
    Write-Host ''
    Write-Host ('=' * 68) -ForegroundColor DarkCyan
    Write-Host ('  ' + $t) -ForegroundColor Cyan
    Write-Host ('=' * 68) -ForegroundColor DarkCyan
}
function Write-Step($t) { Write-Host ''; Write-Host ('> ' + $t) -ForegroundColor White }
function Write-Ok($t)   { Write-Host ('  [OK]   ' + $t) -ForegroundColor Green }
function Write-Bad($t)  { Write-Host ('  [FAIL] ' + $t) -ForegroundColor Red }
function Write-Info($t) { Write-Host ('         ' + $t) -ForegroundColor DarkGray }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not (Test-Path (Join-Path $RepoRoot 'AGENTS.md'))) { $RepoRoot = (Get-Location).Path }
Set-Location $RepoRoot

Write-Head '砚池 (Inkwell) —— Windows 出包'
Write-Host ('  仓库: ' + $RepoRoot)
Write-Host ('  模式: ' + $(if ($DevBuild) { '调试包' } else { '发布包' }))

# ---------------------------------------------------------------- 环境自检
if (-not $SkipChecks) {
    Write-Head '环境自检'
    $bad = $false

    foreach ($c in @('node', 'pnpm', 'cargo')) {
        $p = Get-Command $c -ErrorAction SilentlyContinue
        if ($p) { Write-Ok ($c + ' -> ' + $p.Source) }
        else    { Write-Bad ($c + ' 未找到'); $bad = $true }
    }

    # cargo 若不在 PATH，尝试用户目录下的 rustup 安装位置
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
        if (Test-Path (Join-Path $cargoBin 'cargo.exe')) {
            $env:Path = $env:Path.TrimEnd(';') + ';' + $cargoBin
            Write-Ok ('cargo 已从 ' + $cargoBin + ' 临时加入 PATH')
            $bad = $false
        }
    }

    # MSVC 链接器是 Rust 在 Windows 上编译的硬性前提
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $vswhere = Join-Path $pf86 'Microsoft Visual Studio\Installer\vswhere.exe'
    $msvc = $null
    if (Test-Path $vswhere) {
        $msvc = & $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    }
    if ($msvc) { Write-Ok ('MSVC -> ' + (@($msvc) -join ' | ')) }
    else       { Write-Bad '未检测到 MSVC C++ 生成工具，Rust 无法链接。请先跑 setup-toolchain.ps1'; $bad = $true }

    if ($bad) {
        Write-Host ''
        Write-Bad '环境不满足，已中止。修好后可加 -SkipChecks 跳过自检。'
        exit 1
    }
}

# ---------------------------------------------------------------- 依赖
Write-Head '安装依赖'
& pnpm install
if ($LASTEXITCODE -ne 0) { Write-Bad 'pnpm install 失败'; exit 1 }
Write-Ok '依赖就绪'

# ---------------------------------------------------------------- 出包
Write-Head '编译并打包'
if ($DevBuild) {
    Write-Info '调试包：--debug --bundles nsis'
    & node (Join-Path $RepoRoot 'personal\scripts\tauri.mjs') build --debug --bundles nsis
} else {
    Write-Info '发布包：--bundles nsis'
    Write-Info '首次编译 Rust 需要 20-40 分钟，之后增量编译会快很多。'
    & node (Join-Path $RepoRoot 'personal\scripts\tauri.mjs') build --bundles nsis
}
$code = $LASTEXITCODE

# ---------------------------------------------------------------- 结果
Write-Head '结果'
if ($code -ne 0) {
    Write-Bad ('构建失败，退出码 ' + $code)
    Write-Host ''
    Write-Host '  排查建议：' -ForegroundColor White
    Write-Host '    1. 先跑  pnpm tauri info  看环境哪项是红叉'
    Write-Host '    2. 看上面的 cargo 报错，通常是缺 MSVC 或 Rust target'
    Write-Host '    3. 首次编译失败重试一次，偶发网络问题会导致 crates 下载中断'
    exit $code
}

$nsisDir = Join-Path $RepoRoot 'src-tauri\target\release\bundle\nsis'
$found = @()
if (Test-Path $nsisDir) {
    $found = @(Get-ChildItem $nsisDir -Filter '*.exe' -ErrorAction SilentlyContinue)
}

if ($found.Count -gt 0) {
    Write-Ok '出包成功'
    Write-Host ''
    foreach ($f in $found) {
        Write-Host ('  安装包: ' + $f.FullName) -ForegroundColor Green
        Write-Host ('  大小  : ' + [Math]::Round($f.Length / 1MB, 1) + ' MB') -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host '  双击安装即可（当前用户安装，不需要管理员）。' -ForegroundColor White
    exit 0
} else {
    Write-Bad ('构建返回成功，但没在 ' + $nsisDir + ' 找到安装包')
    exit 1
}
