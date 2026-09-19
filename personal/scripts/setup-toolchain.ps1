#Requires -Version 5.1
<#
    砚池 (Inkwell) —— 开发工具链一键安装 / 体检脚本

    用途：检测并补齐构建本项目所需的全部工具链。
      [1] Rust (rustup + stable-msvc)
      [2] Visual Studio 2022 生成工具（C++ 桌面开发工作负载，约 6GB）
      [3] JDK 检查（Android 构建需要 17+）
      [4] Android SDK：cmdline-tools / platform-tools / platform / build-tools / NDK
      [5] Rust 的 Android 交叉编译目标
      [6] Node.js / pnpm 检查

    特性：全部步骤幂等，可反复运行；已装好的组件会自动跳过。
          每一步都先检测、再安装、最后验证，不会盲目执行。

    用法（请用【管理员身份】打开 PowerShell）：
        powershell -ExecutionPolicy Bypass -File .\personal\scripts\setup-toolchain.ps1

    只想体检、不安装：
        powershell -ExecutionPolicy Bypass -File .\personal\scripts\setup-toolchain.ps1 -VerifyOnly

    参数：
        -VerifyOnly        只检查环境并输出报告
        -SkipVisualStudio  跳过 VS 生成工具（已装过时用，省时间）
        -SkipAndroid       跳过 Android 部分（先只做 Windows 端时用）

    日志：personal\notes\toolchain-install.log
#>

[CmdletBinding()]
param(
    [switch]$VerifyOnly,
    [switch]$SkipVisualStudio,
    [switch]$SkipAndroid
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

# ============================================================================
#  输出 helper
# ============================================================================
$script:WarnList = @()
$script:FailList = @()
$script:LogPath  = $null

function Write-Log($msg) {
    if ($script:LogPath) {
        $stamp = (Get-Date).ToString('HH:mm:ss')
        Add-Content -Path $script:LogPath -Value ('[' + $stamp + '] ' + $msg) -Encoding UTF8
    }
}
function Write-Head($t) {
    Write-Host ''
    Write-Host ('=' * 68) -ForegroundColor DarkCyan
    Write-Host ('  ' + $t) -ForegroundColor Cyan
    Write-Host ('=' * 68) -ForegroundColor DarkCyan
    Write-Log ('== ' + $t)
}
function Write-Step($t) { Write-Host ''; Write-Host ('> ' + $t) -ForegroundColor White; Write-Log ('STEP ' + $t) }
function Write-Ok($t)   { Write-Host ('  [OK]   ' + $t) -ForegroundColor Green;    Write-Log ('OK   ' + $t) }
function Write-Skip($t) { Write-Host ('  [SKIP] ' + $t) -ForegroundColor DarkGray; Write-Log ('SKIP ' + $t) }
function Write-Info($t) { Write-Host ('         ' + $t) -ForegroundColor DarkGray }
function Write-Warn2($t){ Write-Host ('  [WARN] ' + $t) -ForegroundColor Yellow; $script:WarnList += $t; Write-Log ('WARN ' + $t) }
function Write-Bad($t)  { Write-Host ('  [FAIL] ' + $t) -ForegroundColor Red;    $script:FailList += $t; Write-Log ('FAIL ' + $t) }

# ============================================================================
#  通用工具
# ============================================================================
function Test-Cmd($name) {
    return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function Update-SessionPath {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = ($m.TrimEnd(';') + ';' + $u.TrimEnd(';'))
}

function Add-UserPath($dir) {
    if (-not $dir) { return }
    if (-not (Test-Path $dir)) { return }
    $cur = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $cur) { $cur = '' }
    $parts = @($cur.Split(';') | Where-Object { $_ -ne '' })
    if ($parts -notcontains $dir) {
        $new = (@($parts) + $dir) -join ';'
        try {
            [Environment]::SetEnvironmentVariable('Path', $new, 'User')
            Write-Info ('已加入用户 PATH: ' + $dir)
        } catch {
            Write-Warn2 ('无法写入用户 PATH（' + $dir + '），请手动添加')
        }
    }
    if (-not (@($env:Path.Split(';')) -contains $dir)) {
        $env:Path = $env:Path.TrimEnd(';') + ';' + $dir
    }
}

function Set-UserEnv($name, $value) {
    if ($VerifyOnly) { return }
    $old = [Environment]::GetEnvironmentVariable($name, 'User')
    try {
        [Environment]::SetEnvironmentVariable($name, $value, 'User')
    } catch {
        Write-Warn2 ($name + ' 写入用户环境变量失败，请手动设置为: ' + $value)
        return
    }
    Set-Item -Path ('Env:' + $name) -Value $value -ErrorAction SilentlyContinue
    if ($old -ne $value) { Write-Info ($name + ' = ' + $value) }
    else                 { Write-Info ($name + ' 已是 ' + $value) }
}

function Invoke-External($exe, [string[]]$argv, $what) {
    Write-Info ('执行: ' + $exe + ' ' + ($argv -join ' '))
    # 用 & 展开数组调用：PowerShell 会把每个元素当作独立参数正确转义。
    # 不要用 Start-Process -ArgumentList —— 它会把数组用空格拼接，
    # 导致含空格的参数（如 --override "... --add ..."）被拆坏，
    # winget 会因此返回 0x8A150002（命令行参数无效）。
    & $exe @argv
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    Write-Log ('exit=' + $code + ' :: ' + $what)
    return $code
}

function Wait-VsInstall($maxMinutes) {
    # VS 引导程序把真正的安装工作交给分离出去的进程后就会立刻返回（exit 0），
    # 此时安装其实还在后台跑。必须轮询进程 + 包目录大小，否则会误报失败。
    $pkg = Join-Path ([Environment]::GetEnvironmentVariable('ProgramData')) 'Microsoft\VisualStudio\Packages'
    $deadline = (Get-Date).AddMinutes($maxMinutes)
    $lastSize = -1
    $stableRounds = 0

    Write-Info '等待后台安装进程结束（引导程序已提前返回，实际仍在安装）...'
    while ((Get-Date) -lt $deadline) {
        $procs = @(Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'vs_BuildTools|vs_setup_bootstrapper|vs_installer|vs_installershell' })
        $size = 0
        if (Test-Path $pkg) {
            $size = (Get-ChildItem $pkg -Recurse -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
        }

        if ($procs.Count -eq 0) {
            if ($lastSize -ge 0) {
                Write-Info ('安装进程已结束，包目录 ' + [Math]::Round($size / 1MB, 1) + ' MB')
            }
            return $true
        }

        # 连续 6 轮（约 3 分钟）体积无变化且进程仍在，视为卡住
        if ($size -eq $lastSize) { $stableRounds++ } else { $stableRounds = 0 }
        $lastSize = $size

        Write-Info ('  安装中... 进程 ' + $procs.Count + ' 个，已下载 ' + [Math]::Round($size / 1MB, 1) + ' MB')
        Start-Sleep -Seconds 30

        if ($stableRounds -ge 6) {
            Write-Warn2 '安装进程仍在但体积 3 分钟无变化，可能卡住，不再等待'
            return $false
        }
    }
    Write-Warn2 ('等待超过 ' + $maxMinutes + ' 分钟仍未结束')
    return $false
}

function Get-FileViaNode($url, $dest) {
    # 本机经代理访问 https 时 Windows schannel 会报 SEC_E_NO_CREDENTIALS，
    # 导致 Invoke-WebRequest / curl 全部失败；Node 用自带 OpenSSL，实测可用。
    $dl = Join-Path $RepoRoot 'personal\scripts\download.mjs'
    if (-not (Test-Path $dl)) {
        Write-Bad ('缺少下载器: ' + $dl)
        return $false
    }
    if (-not (Test-Cmd 'node')) {
        Write-Bad '未找到 node，无法下载'
        return $false
    }
    & node $dl $url $dest
    return ($LASTEXITCODE -eq 0) -and (Test-Path $dest)
}

function Get-HighestVersion($items) {
    $parsed = @()
    foreach ($i in $items) {
        $nums = @()
        foreach ($seg in ($i -split '[^0-9]+')) { if ($seg -ne '') { $nums += [int]$seg } }
        if ($nums.Count -gt 0) { $parsed += [pscustomobject]@{ Raw = $i; Nums = $nums } }
    }
    $best = $null
    foreach ($p in $parsed) {
        if ($null -eq $best) { $best = $p; continue }
        $cmp = 0
        $maxLen = [Math]::Max($p.Nums.Count, $best.Nums.Count)
        for ($k = 0; $k -lt $maxLen; $k++) {
            $a = 0; if ($k -lt $best.Nums.Count) { $a = $best.Nums[$k] }
            $b = 0; if ($k -lt $p.Nums.Count)    { $b = $p.Nums[$k] }
            if ($b -ne $a) { $cmp = $b - $a; break }
        }
        if ($cmp -gt 0) { $best = $p }
    }
    if ($best) { return $best.Raw }
    return $null
}

# ============================================================================
#  开场
# ============================================================================
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not (Test-Path (Join-Path $RepoRoot 'AGENTS.md'))) { $RepoRoot = (Get-Location).Path }
$script:LogPath = Join-Path $RepoRoot 'personal\notes\toolchain-install.log'
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $script:LogPath)
Set-Content -Path $script:LogPath -Value ('砚池 (Inkwell) 工具链安装日志  ' + (Get-Date)) -Encoding UTF8

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Head '砚池 (Inkwell) 开发工具链安装'
Write-Host ('  仓库目录 : ' + $RepoRoot)
$roleText = '普通用户  <-- 建议以管理员身份重开'
if ($isAdmin) { $roleText = '管理员' }
Write-Host ('  运行身份 : ' + $roleText)
$modeText = '安装 + 体检'
if ($VerifyOnly) { $modeText = '仅体检' }
Write-Host ('  模式     : ' + $modeText)
Write-Host ('  日志     : ' + $script:LogPath)

if ((-not $isAdmin) -and (-not $VerifyOnly)) {
    Write-Host ''
    Write-Warn2 '当前不是管理员权限。安装 Visual Studio 生成工具需要管理员权限。'
    Write-Host '         请关掉本窗口，重新以【管理员身份】打开 PowerShell 后再运行。' -ForegroundColor Yellow
    if ($host.Name -eq 'ConsoleHost') {
        $ans = Read-Host '         仍要继续吗？(输入 y 继续 / 直接回车退出)'
        if ($ans -ne 'y') { Write-Host '已取消。'; exit 1 }
    } else {
        Write-Host '（非交互环境，直接退出）'
        exit 1
    }
}

# ============================================================================
#  [0] 系统前置
# ============================================================================
Write-Head '[0/6] 系统前置检查'

$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) {
    Write-Ok ('操作系统: ' + $os.Caption + ' (Build ' + $os.BuildNumber + ')')
    if ([int]$os.BuildNumber -lt 17763) { Write-Warn2 'Windows 版本偏旧，Tauri 需要 Windows 10 1809 及以上' }
} else {
    Write-Info '无法读取操作系统信息（可能被系统策略限制），跳过'
}

$driveName = (Get-Item $RepoRoot).PSDrive.Name
try {
    $free = (Get-PSDrive -Name $driveName).Free
    if ($free) {
        $freeGB = [Math]::Round($free / 1GB, 1)
        if ($freeGB -lt 20) { Write-Warn2 ('磁盘 ' + $driveName + ': 剩余 ' + $freeGB + ' GB，建议至少 30 GB') }
        else                { Write-Ok  ('磁盘 ' + $driveName + ': 剩余 ' + $freeGB + ' GB') }
    }
} catch {
    Write-Info ('无法读取磁盘剩余空间: ' + $driveName)
}

if (-not (Test-Cmd 'winget')) {
    Write-Warn2 'winget 不可用。部分组件将改为手动下载方式安装。'
} else {
    Write-Ok 'winget 可用'
}

# ============================================================================
#  [1] Rust
# ============================================================================
Write-Head '[1/6] Rust 工具链'

$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (@($env:Path.Split(';')) -contains $cargoBin)) {
    $env:Path = $env:Path.TrimEnd(';') + ';' + $cargoBin
}

if (Test-Cmd 'rustc') {
    Write-Skip ('已安装: ' + (rustc --version))
} elseif ($VerifyOnly) {
    Write-Bad '未安装 Rust'
} else {
    $installed = $false
    if (Test-Cmd 'winget') {
        Write-Info '通过 winget 安装 rustup ...'
        $null = Invoke-External 'winget' @('install','--id','Rustlang.Rustup','-e','--accept-source-agreements','--accept-package-agreements','--disable-interactivity') 'winget rustup'
        Update-SessionPath
        $env:Path = $env:Path.TrimEnd(';') + ';' + $cargoBin
        if (Test-Path (Join-Path $cargoBin 'rustup.exe')) { $installed = $true }
    }
    if (-not $installed) {
        Write-Info 'winget 方式未成功，改为下载 rustup-init.exe 安装 ...'
        $tmp = Join-Path $RepoRoot 'personal\tools\rustup-init.exe'
        if (Get-FileViaNode 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' $tmp) {
            $null = Invoke-External $tmp @('-y','--default-toolchain','stable-x86_64-pc-windows-msvc','--profile','default','--no-modify-path') 'rustup-init'
            $env:Path = $env:Path.TrimEnd(';') + ';' + $cargoBin
            if (Test-Path (Join-Path $cargoBin 'rustc.exe')) { $installed = $true }
        }
    }
    if ($installed) { Write-Ok 'rustup 安装完成' }
}

if (-not $VerifyOnly) { Add-UserPath $cargoBin }

if ((Test-Cmd 'rustup') -and (-not $VerifyOnly)) {
    Write-Info '切换默认工具链为 stable-msvc ...'
    $null = Invoke-External 'rustup' @('default','stable-x86_64-pc-windows-msvc') 'rustup default'
}
if (Test-Cmd 'rustc') { Write-Ok ('rustc : ' + (rustc --version)) }
if (Test-Cmd 'cargo') { Write-Ok ('cargo : ' + (cargo --version)) }

# ============================================================================
#  [2] Visual Studio 生成工具
# ============================================================================
Write-Head '[2/6] Visual Studio 2022 生成工具 (C++ 桌面开发)'

$pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$vswhere = Join-Path $pf86 'Microsoft Visual Studio\Installer\vswhere.exe'
$vsFound = $false
if (Test-Path $vswhere) {
    $vsPaths = & $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($vsPaths) {
        $vsFound = $true
        Write-Ok ('已安装 C++ 生成工具: ' + (@($vsPaths) -join ' | '))
    }
}

if ($vsFound) {
    Write-Skip 'Visual Studio C++ 生成工具已就绪'
} elseif ($SkipVisualStudio) {
    Write-Warn2 '已按参数跳过 VS 生成工具（Rust 的 MSVC 链接会失败，除非你已用其他方式装好）'
} elseif ($VerifyOnly) {
    Write-Bad '未检测到 Visual Studio C++ 生成工具（Rust 链接必需）'
} else {
    # 优先用仓库里预下载好的官方引导程序：参数传递可靠，且不依赖 winget。
    $vsBootstrapper = Join-Path $RepoRoot 'personal\tools\vs_BuildTools.exe'
    if (-not (Test-Path $vsBootstrapper)) {
        Write-Info '仓库内没有引导程序，先下载 vs_BuildTools.exe ...'
        $null = Get-FileViaNode 'https://aka.ms/vs/17/release/vs_BuildTools.exe' $vsBootstrapper
    }

    if (-not (Test-Path $vsBootstrapper)) {
        Write-Bad '未能获得 VS 生成工具引导程序。请手动下载 https://aka.ms/vs/17/release/vs_BuildTools.exe 并勾选「使用 C++ 的桌面开发」。'
    } else {
        Write-Info '即将安装 VS 2022 生成工具 + VCTools 工作负载（约 6GB，视网速可能 10-40 分钟）'
        Write-Info '安装期间请勿关闭本窗口。'
        $code = Invoke-External $vsBootstrapper @(
            '--quiet','--wait','--norestart','--nocache',
            '--add','Microsoft.VisualStudio.Workload.VCTools',
            '--includeRecommended'
        ) 'vs bootstrapper'

        # 引导程序返回不代表装完，必须等后台进程真正结束。
        $null = Wait-VsInstall 90

        if (Test-Path $vswhere) {
            $vsPaths = & $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
            if ($vsPaths) {
                Write-Ok ('VS 生成工具安装完成: ' + (@($vsPaths) -join ' | '))
                $vsFound = $true
            } else {
                Write-Bad ('引导程序退出码 ' + $code + '，但未检测到 C++ 组件。请打开「Visual Studio Installer」手动确认，或查看 %TEMP%\dd_*.log')
            }
        } else {
            Write-Bad '安装后仍未找到 vswhere，请重试或手动安装'
        }
    }
}

# ============================================================================
#  [3] JDK
# ============================================================================
Write-Head '[3/6] JDK (Android 构建需要 17+)'

$jdkOk = $false
if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    Write-Ok ('JAVA_HOME = ' + $env:JAVA_HOME)
    $jver = ((& (Join-Path $env:JAVA_HOME 'bin\java.exe') -version 2>&1 | Select-Object -First 1) -join '')
    Write-Info ('版本: ' + $jver)
    if ($jver -match '(\d+)') { if ([int]$Matches[1] -ge 17) { $jdkOk = $true } }
} elseif (Test-Cmd 'java') {
    Write-Warn2 '找到了 java 命令但未设置 JAVA_HOME，Android 构建可能失败'
    $jdkOk = $true
} else {
    Write-Bad '未找到 JDK。请安装 Microsoft OpenJDK 17 或 21，并设置 JAVA_HOME'
}

# ============================================================================
#  [4] Android SDK
# ============================================================================
Write-Head '[4/6] Android SDK (cmdline-tools / platform-tools / platform / build-tools / NDK)'

$AndroidHome = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$SdkManager  = Join-Path $AndroidHome 'cmdline-tools\latest\bin\sdkmanager.bat'

if ($SkipAndroid) {
    Write-Warn2 '已按参数跳过 Android 组件'
} else {
    if (-not (Test-Path $SdkManager)) {
        if ($VerifyOnly) {
            Write-Bad ('未找到 sdkmanager: ' + $SdkManager)
        } else {
            Write-Step '下载 Android Command-line Tools'
            $candidates = @(
                'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip',
                'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip',
                'https://dl.google.com/android/repository/commandlinetools-win-10406996_latest.zip'
            )
            $zip = Join-Path $RepoRoot 'personal\tools\android-cmdline-tools.zip'
            $downloaded = $false
            foreach ($url in $candidates) {
                Write-Info ('尝试: ' + $url)
                if (Get-FileViaNode $url $zip) {
                    $downloaded = $true
                    Write-Ok '下载完成'
                    break
                }
                Write-Info '  失败，换下一个镜像'
            }
            if (-not $downloaded) {
                Write-Bad 'Command-line Tools 下载失败，请检查网络或代理'
            } else {
                $tmpDir = Join-Path $env:TEMP 'android-cmdline-extract'
                if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
                Expand-Archive -Path $zip -DestinationPath $tmpDir -Force
                $dest = Join-Path $AndroidHome 'cmdline-tools'
                New-Item -ItemType Directory -Force -Path $dest | Out-Null
                $latest = Join-Path $dest 'latest'
                if (Test-Path $latest) { Remove-Item $latest -Recurse -Force }
                Move-Item -Path (Join-Path $tmpDir 'cmdline-tools') -Destination $latest
                Write-Ok ('已解压到 ' + $latest)
            }
        }
    } else {
        Write-Ok 'sdkmanager 已存在'
    }

    if (Test-Path $SdkManager) {
        if (-not $VerifyOnly) {
            Write-Step '接受 Android SDK 许可协议'
            $yes = (@('y') * 60) -join [Environment]::NewLine
            $yes | & $SdkManager ('--sdk_root=' + $AndroidHome) '--licenses' 2>&1 | Out-Null
            Write-Ok '许可协议已处理'
        }

        Write-Step '查询可安装的 SDK 包'
        $listOut = ''
        try { $listOut = (& $SdkManager ('--sdk_root=' + $AndroidHome) '--list' 2>&1 | Out-String) } catch { }
        Write-Log ('sdkmanager --list 输出长度 ' + $listOut.Length)

        $availPlatforms  = @([regex]::Matches($listOut, 'platforms;android-(\d+)')  | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
        $availBuildTools = @([regex]::Matches($listOut, 'build-tools;([\d.]+)')      | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
        $availNdk        = @([regex]::Matches($listOut, 'ndk;([\d.]+)')              | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)

        $wantPlatform = Get-HighestVersion $availPlatforms
        $wantBuild    = Get-HighestVersion $availBuildTools
        $wantNdk      = Get-HighestVersion @($availNdk | Where-Object { $_ -like '27.*' })
        if (-not $wantNdk) { $wantNdk = Get-HighestVersion @($availNdk | Where-Object { $_ -like '26.*' }) }
        if (-not $wantNdk) { $wantNdk = Get-HighestVersion $availNdk }

        Write-Info ('最新 platform    : android-' + $wantPlatform)
        Write-Info ('最新 build-tools : ' + $wantBuild)
        Write-Info ('选用 NDK         : ' + $wantNdk)

        if (-not $VerifyOnly) {
            $pkgs = @('platform-tools', 'cmdline-tools;latest')
            if ($wantPlatform) { $pkgs += ('platforms;android-' + $wantPlatform) }
            if ($wantBuild)    { $pkgs += ('build-tools;' + $wantBuild) }
            if ($wantNdk)      { $pkgs += ('ndk;' + $wantNdk) }

            Write-Step ('安装 SDK 包: ' + ($pkgs -join ', '))
            Write-Info 'NDK 约 2.5GB，请耐心等待 ...'
            $null = Invoke-External $SdkManager (@('--sdk_root=' + $AndroidHome) + $pkgs) 'sdkmanager install'

            foreach ($p in $pkgs) {
                $probe = Join-Path $AndroidHome ($p -replace ';', '\')
                if (Test-Path $probe) { Write-Ok ('已安装 ' + $p) }
                else                  { Write-Warn2 ('未确认安装 ' + $p) }
            }

            if ($wantNdk) {
                $ndkPath = Join-Path $AndroidHome ('ndk\' + $wantNdk)
                if (Test-Path $ndkPath) {
                    Set-UserEnv 'NDK_HOME' $ndkPath
                    Set-UserEnv 'ANDROID_NDK_HOME' $ndkPath
                }
            }
        }
    }
}

if ((-not $SkipAndroid) -and (-not $VerifyOnly)) {
    Set-UserEnv 'ANDROID_HOME' $AndroidHome
    Set-UserEnv 'ANDROID_SDK_ROOT' $AndroidHome
    Add-UserPath (Join-Path $AndroidHome 'platform-tools')
    Add-UserPath (Join-Path $AndroidHome 'cmdline-tools\latest\bin')
}

# ============================================================================
#  [5] Rust Android 目标
# ============================================================================
Write-Head '[5/6] Rust Android 交叉编译目标'

if ($SkipAndroid) {
    Write-Warn2 '已按参数跳过 Rust Android 交叉编译目标'
} elseif (-not (Test-Cmd 'rustup')) {
    Write-Bad 'rustup 不可用，无法添加 Android 目标'
} else {
    $targets = @('aarch64-linux-android', 'armv7-linux-androideabi', 'i686-linux-android', 'x86_64-linux-android')
    $have = ((rustup target list --installed 2>&1) -join ' ')
    if ($VerifyOnly) {
        foreach ($t in $targets) {
            if ($have -like ('*' + $t + '*')) { Write-Ok ('已安装 ' + $t) }
            else                              { Write-Bad ('缺少 ' + $t) }
        }
    } else {
        $need = @($targets | Where-Object { $have -notlike ('*' + $_ + '*') })
        if ($need.Count -eq 0) {
            Write-Skip '四个 Android 目标均已安装'
        } else {
            Write-Info ('待添加: ' + ($need -join ', '))
            foreach ($t in $need) {
                $null = Invoke-External 'rustup' @('target','add',$t) ('rustup target add ' + $t)
            }
            $have2 = ((rustup target list --installed 2>&1) -join ' ')
            foreach ($t in $targets) {
                if ($have2 -like ('*' + $t + '*')) { Write-Ok ('已安装 ' + $t) }
                else                               { Write-Warn2 ('添加失败 ' + $t) }
            }
        }
    }
}

# ============================================================================
#  [6] Node / pnpm
# ============================================================================
Write-Head '[6/6] Node.js 与 pnpm'

if (Test-Cmd 'node') {
    $nv = (node --version) -replace '^v', ''
    $major = [int](@($nv -split '\.')[0])
    if ($major -ge 20) { Write-Ok ('Node.js v' + $nv) }
    else               { Write-Bad ('Node.js v' + $nv + ' 过旧，Vite 7 需要 20.19 以上') }
} else {
    Write-Bad '未安装 Node.js'
}

if (Test-Cmd 'pnpm') { Write-Ok ('pnpm ' + (pnpm --version)) }
else { Write-Warn2 '未安装 pnpm，可执行: corepack enable ; corepack prepare pnpm@latest --activate' }

# ============================================================================
#  汇总
# ============================================================================
Write-Head '体检汇总'

$report = [ordered]@{}
$report['Rust (rustc)']       = (Test-Cmd 'rustc')
$report['Cargo']              = (Test-Cmd 'cargo')
$report['MSVC C++ 生成工具']  = $vsFound
$report['JDK 17+']            = $jdkOk
$report['Node.js 20+']        = (Test-Cmd 'node')
$report['pnpm']               = (Test-Cmd 'pnpm')
$report['Android sdkmanager'] = (Test-Path $SdkManager)
$report['Android adb']        = (Test-Path (Join-Path $AndroidHome 'platform-tools\adb.exe'))
$report['ANDROID_HOME 变量']  = [bool]([Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User'))

Write-Host ''
foreach ($k in $report.Keys) {
    if ($report[$k]) { $mark = '[OK]  '; $color = 'Green' }
    else             { $mark = '[--]  '; $color = 'Yellow' }
    Write-Host ('  ' + $mark + $k) -ForegroundColor $color
}

Write-Host ''
if ($script:FailList.Count -gt 0) {
    Write-Host ('  存在 ' + $script:FailList.Count + ' 项问题：') -ForegroundColor Red
    foreach ($f in $script:FailList) { Write-Host ('    - ' + $f) -ForegroundColor Red }
}
if ($script:WarnList.Count -gt 0) {
    Write-Host ('  存在 ' + $script:WarnList.Count + ' 项提醒：') -ForegroundColor Yellow
    foreach ($w in $script:WarnList) { Write-Host ('    - ' + $w) -ForegroundColor Yellow }
}
if (($script:FailList.Count -eq 0) -and ($script:WarnList.Count -eq 0)) {
    Write-Host '  全部就绪，可以开始构建了。' -ForegroundColor Green
}

Write-Host ''
Write-Host '  下一步：' -ForegroundColor White
Write-Host '    1. 关闭并重新打开一个【普通】PowerShell 窗口（让新的环境变量生效）'
Write-Host '    2. 进入仓库目录运行:  pnpm tauri info'
Write-Host '    3. 把输出贴给 Agent，即可继续阶段 0 的构建工作'
Write-Host ''
Write-Host ('  日志已保存: ' + $script:LogPath) -ForegroundColor DarkGray
Write-Host ''
