<#
    砚池 (Inkwell) —— Android 一键出包脚本

    产物：APK（src-tauri/gen/android/app/build/outputs/apk/*/release/）

    用法：
        powershell -ExecutionPolicy Bypass -File .\personal\scripts\build-android.ps1

    参数：
        -DevBuild   出调试 APK（编译更快，可断点调试）
        -Install    出包后自动用 adb 安装到已连接设备

    为什么不用官方的 pnpm tauri android build：
      Tauri 会把编译好的 .so 以「符号链接」方式放进 jniLibs，
      而 Windows 创建符号链接需要「开发者模式」或管理员权限。
      本脚本改为手动复制 .so 再直接调 Gradle，效果等价且无需特权。
      详见 src-tauri/tauri.js 顶部注释。

    前置条件：先跑过 personal/scripts/setup-android.mjs
#>

[CmdletBinding()]
param(
    [switch]$DevBuild,
    [switch]$Install
)

$ErrorActionPreference = 'Continue'

function Write-Head($t) {
    Write-Host ''
    Write-Host ('=' * 68) -ForegroundColor DarkCyan
    Write-Host ('  ' + $t) -ForegroundColor Cyan
    Write-Host ('=' * 68) -ForegroundColor DarkCyan
}
function Write-Ok($t)   { Write-Host ('  [OK]   ' + $t) -ForegroundColor Green }
function Write-Bad($t)  { Write-Host ('  [FAIL] ' + $t) -ForegroundColor Red }
function Write-Info($t) { Write-Host ('         ' + $t) -ForegroundColor DarkGray }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not (Test-Path (Join-Path $RepoRoot 'AGENTS.md'))) { $RepoRoot = (Get-Location).Path }
Set-Location $RepoRoot

Write-Head '砚池 (Inkwell) —— Android 出包'
Write-Host ('  仓库: ' + $RepoRoot)
Write-Host ('  模式: ' + $(if ($DevBuild) { '调试包' } else { '发布包' }))

# ---------------------------------------------------------------- 环境
Write-Head '准备环境变量'

$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

$ndkRoot = Join-Path $env:ANDROID_HOME 'ndk'
if (Test-Path $ndkRoot) {
    $ndk = Get-ChildItem $ndkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($ndk) { $env:NDK_HOME = $ndk.FullName; $env:ANDROID_NDK_HOME = $ndk.FullName }
}

$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (@($env:Path.Split(';')) -contains $cargoBin)) { $env:Path = $env:Path.TrimEnd(';') + ';' + $cargoBin }

$bad = $false
if (-not (Test-Path $env:ANDROID_HOME)) { Write-Bad ('Android SDK 不存在: ' + $env:ANDROID_HOME); $bad = $true }
else { Write-Ok ('ANDROID_HOME = ' + $env:ANDROID_HOME) }

if (-not $env:NDK_HOME) { Write-Bad '未找到 Android NDK'; $bad = $true }
else { Write-Ok ('NDK_HOME = ' + $env:NDK_HOME) }

if (-not $env:JAVA_HOME) { Write-Bad '未设置 JAVA_HOME'; $bad = $true }
else { Write-Ok ('JAVA_HOME = ' + $env:JAVA_HOME) }

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Write-Bad 'cargo 不在 PATH'; $bad = $true }

if ($bad) {
    Write-Host ''
    Write-Bad '环境不满足。请先运行:'
    Write-Host '    node .\personal\scripts\setup-android.mjs' -ForegroundColor White
    exit 1
}

# ---------------------------------------------------------------- 依赖
Write-Head '安装前端依赖'
& pnpm install
if ($LASTEXITCODE -ne 0) { Write-Bad 'pnpm install 失败'; exit 1 }
Write-Ok '依赖就绪'

# ---------------------------------------------------------------- 前端
Write-Head '构建前端'
& pnpm build
if ($LASTEXITCODE -ne 0) { Write-Bad '前端构建失败'; exit 1 }
Write-Ok '前端产物已生成 (dist/)'

# ---------------------------------------------------------------- 初始化工程
$genDir = Join-Path $RepoRoot 'src-tauri\gen\android'
if (-not (Test-Path $genDir)) {
    Write-Head '初始化 Android 工程'
    & node (Join-Path $RepoRoot 'personal\scripts\tauri.mjs') android init
    if ($LASTEXITCODE -ne 0) { Write-Bad 'tauri android init 失败'; exit 1 }
    Write-Ok 'Android 工程已生成'
}

# ---------------------------------------------------------------- 放置 .so
Write-Head '放置已编译的 .so'
$targets = @{
    'aarch64-linux-android'   = 'arm64-v8a'
    'armv7-linux-androideabi' = 'armeabi-v7a'
    'i686-linux-android'      = 'x86'
    'x86_64-linux-android'    = 'x86_64'
}

$placed = 0
foreach ($t in $targets.Keys) {
    $src = Join-Path $RepoRoot ('src-tauri\target\' + $t + '\release\libinkwell_lib.so')
    if (Test-Path $src) {
        $dstDir = Join-Path $genDir ('app\src\main\jniLibs\' + $targets[$t])
        New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
        $dst = Join-Path $dstDir 'libinkwell_lib.so'
        if (Test-Path $dst) { Remove-Item $dst -Force -ErrorAction SilentlyContinue }
        Copy-Item $src $dst -Force
        Write-Ok ($t + ' -> ' + $targets[$t])
        $placed++
    }
}
if ($placed -eq 0) {
    Write-Info '尚无已编译的 .so，交由 Gradle 的 Rust 插件编译（经 src-tauri/tauri.js）'
} else {
    Write-Info ('已放置 ' + $placed + ' 个架构')
}

# ---------------------------------------------------------------- 版本号同步
# gen/android/app/tauri.properties 是 Tauri CLI 生成的文件，而我们的 Android 流程
# 绕过了 CLI（见 src-tauri/tauri.js 的说明），它不会自己更新 —— 于是会出现
# 「APK 报 0.1.0、应用内显示 0.1.1」这种对不上号的情况（真发生过）。
# 注意 Gradle 在**配置阶段**就要读它，所以必须在调用 Gradle 之前写好。
$conf = Get-Content (Join-Path $RepoRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $conf.version
$seg = $ver.Split('.')
$vcode = [int]$seg[0] * 1000000 + [int]$seg[1] * 1000 + [int]$seg[2]
$propPath = Join-Path $genDir 'app\tauri.properties'
$propText = "// THIS FILE IS AUTOGENERATED. DO NOT EDIT DIRECTLY.`n" +
            "tauri.android.versionName=$ver`n" +
            "tauri.android.versionCode=$vcode`n"
# 用无 BOM 的 UTF-8：Java 的 Properties.load 按 ISO-8859-1 读，BOM 会混进第一个键
[System.IO.File]::WriteAllText($propPath, $propText, (New-Object System.Text.UTF8Encoding($false)))
Write-Head '同步 APK 版本号'
Write-Ok ("versionName=$ver  versionCode=$vcode")

# ---------------------------------------------------------------- Gradle
Write-Head 'Gradle 打包'
$gradleTask = if ($DevBuild) { 'assembleDebug' } else { 'assembleRelease' }
Write-Info ('执行 gradlew ' + $gradleTask)
Write-Info '首次构建需下载 Gradle 与 AndroidX 依赖，可能 10-20 分钟。'

Push-Location $genDir
& .\gradlew.bat $gradleTask --no-daemon 2>&1 | Select-Object -Last 30
$code = $LASTEXITCODE
Pop-Location

# ---------------------------------------------------------------- 结果
Write-Head '结果'
if ($code -ne 0) {
    Write-Bad ('Gradle 失败，退出码 ' + $code)
    Write-Host ''
    Write-Host '  排查建议：' -ForegroundColor White
    Write-Host '    1. 确认 ANDROID_HOME / NDK_HOME / JAVA_HOME 三个变量正确'
    Write-Host '    2. 若是下载超时，跑 node .\personal\scripts\fetch-gradle.mjs 预置 Gradle'
    Write-Host '    3. 看上面 Gradle 的具体报错行'
    exit $code
}

$apkRoot = Join-Path $genDir 'app\build\outputs\apk'
$apks = @(Get-ChildItem $apkRoot -Filter '*.apk' -Recurse -ErrorAction SilentlyContinue)

if ($apks.Count -eq 0) { Write-Bad ('未在 ' + $apkRoot + ' 找到 APK'); exit 1 }

# ---- 签名校验（硬性）----
# 未签名的 APK 在 Android 上**根本装不上**：安装器的 getPackageArchiveInfo() 返回 null，
# 用户只会看到 "packageinfo is null"。所以这里拦住，绝不放未签名的包出去。
$apksigner = $null
$btRoot = Join-Path $env:ANDROID_HOME 'build-tools'
if (Test-Path $btRoot) {
    $bt = Get-ChildItem $btRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($bt) { $apksigner = Join-Path $bt.FullName 'apksigner.bat' }
}
if ($apksigner -and (Test-Path $apksigner)) {
    $unsigned = @()
    foreach ($a in $apks) {
        & $apksigner verify $a.FullName *> $null
        if ($LASTEXITCODE -ne 0) { $unsigned += $a.Name }
    }
    if ($unsigned.Count -gt 0) {
        Write-Bad ('以下 APK 未签名，装上会报 packageinfo is null：' + ($unsigned -join '、'))
        Write-Info '检查 src-tauri/gen/android/keystore.properties 是否存在、密码是否正确'
        exit 1
    }
    Write-Ok ('签名校验通过（' + $apks.Count + ' 个 APK）')
} else {
    Write-Info '未找到 apksigner，跳过签名校验'
}

# ---- 内嵌资源校验（硬性）----
# 若二进制是在开发模式下编译的，就不会内嵌前端资源，而是去连 devUrl，
# 手机上表现为一启动就报 'Failed to request http://localhost:1420/'。
# 判据：产物 .so 里能搜到 dist 下的 index-*.js 文件名。
# 注意不能拿 'localhost:1420' 当判据 —— devUrl 字符串始终会编进二进制里。
Add-Type -AssemblyName System.IO.Compression.FileSystem
$noAssets = @()
foreach ($a in $apks) {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($a.FullName)
    try {
        $so = $zip.Entries | Where-Object { $_.FullName -like 'lib/*/libinkwell_lib.so' } | Select-Object -First 1
        if (-not $so) { $noAssets += ($a.Name + '（包内没有 .so）'); continue }
        $ms = New-Object System.IO.MemoryStream
        $st = $so.Open(); $st.CopyTo($ms); $st.Close()
        $txt = [System.Text.Encoding]::ASCII.GetString($ms.ToArray())
        if (-not [regex]::IsMatch($txt, 'index-[A-Za-z0-9_\-]{6,12}\.js')) { $noAssets += $a.Name }
    } finally { $zip.Dispose() }
}
if ($noAssets.Count -gt 0) {
    Write-Bad ('以下 APK 未内嵌前端资源（开发模式产物，装上会连 localhost:1420）：' + ($noAssets -join '、'))
    Write-Info '检查 src-tauri/Cargo.toml 的 custom-protocol 特性、src-tauri/tauri.js 的 --features 传参'
    exit 1
}
Write-Ok ('内嵌资源校验通过（' + $apks.Count + ' 个 APK）')

Write-Ok ('出包成功，共 ' + $apks.Count + ' 个 APK')
Write-Host ''
foreach ($a in ($apks | Sort-Object Length)) {
    # 目录结构是 apk/<abi>/release/xxx.apk，ABI 在上一级
    $abi = $a.Directory.Parent.Name
    Write-Host ('  ' + $abi.PadRight(10) + [Math]::Round($a.Length / 1MB, 1).ToString().PadLeft(6) + ' MB   ' + $a.FullName) -ForegroundColor Green
}
Write-Host ''
Write-Host '  手机安装选 arm64（绝大多数安卓机）。' -ForegroundColor White

if ($Install) {
    Write-Head '安装到设备'
    $adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
    $devices = & $adb devices 2>&1 | Select-String -Pattern 'device$'
    if (-not $devices) { Write-Bad '未检测到设备（需开启 USB 调试）'; exit 1 }
    $target = ($apks | Where-Object { $_.Directory.Parent.Name -eq 'arm64' } | Select-Object -First 1)
    if (-not $target) { $target = $apks | Sort-Object Length -Descending | Select-Object -First 1 }
    Write-Info ('安装 ' + $target.Name)
    & $adb install -r $target.FullName
    if ($LASTEXITCODE -eq 0) { Write-Ok '已安装到设备' } else { Write-Bad 'adb install 失败' }
}

exit 0
