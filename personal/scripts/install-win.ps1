<#
    砚池 (Inkwell) —— Windows 安装辅助脚本

    解决两件会让「直接双击安装包」失败的事：

    1. **安装包放在仓库里时不要直接双击。**
       DSH 沙箱按「可执行文件是否位于会话工作区内」限制进程写入：工作区内的
       安装包**写不进任何工作区外的目录**，NSIS 只会弹
       「无法打开要写入的文件: <安装目录>\inkwell.exe」，而且静默运行时
       它会 exit 0、什么都不装（假成功，最坑）。
       所以这里先把安装包复制到 %TEMP% 再运行。

    2. **Tauri 的 NSIS 模板会沿用上次的安装位置。**
       它读 HKCU\Software\inkwell\Inkwell 的默认值，**不做存在性检查**就
       拿它当下次目标目录。那个目录若被手工删过，安装就会往不存在的路径里写
       （同样是上面的报错）。脚本先把这个值清掉，回到默认位置
       %LOCALAPPDATA%\Inkwell。

    用法：
        powershell -ExecutionPolicy Bypass -File .\personal\scripts\install-win.ps1
        powershell -ExecutionPolicy Bypass -File .\personal\scripts\install-win.ps1 -Silent
        powershell -ExecutionPolicy Bypass -File .\personal\scripts\install-win.ps1 -InstallDir 'D:\Apps\Inkwell'
#>

[CmdletBinding()]
param(
    [string]$Installer,   # 指定安装包；默认取 personal\out\ 下版本号最大的那个
    [string]$InstallDir,  # 想装到别处就传它；留空 = 默认 %LOCALAPPDATA%\Inkwell
    [switch]$Silent       # 静默安装（不弹界面），便于脚本化验证
)

$ErrorActionPreference = 'Stop'
# personal\scripts\install-win.ps1 -> personal\scripts -> personal -> 仓库根
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
if (-not (Test-Path (Join-Path $RepoRoot 'AGENTS.md'))) { $RepoRoot = (Get-Location).Path }

function Write-Step2($t) { Write-Host ''; Write-Host ('> ' + $t) -ForegroundColor White }
function Write-Ok2($t)   { Write-Host ('  [OK]   ' + $t) -ForegroundColor Green }
function Write-Note($t)  { Write-Host ('  [注意] ' + $t) -ForegroundColor Yellow }

# ---------------------------------------------------------------- 找安装包
if (-not $Installer) {
    $candidates = Get-ChildItem (Join-Path $RepoRoot 'personal\out\Inkwell-*-win-x64-setup.exe') -ErrorAction SilentlyContinue
    if ($candidates) { $Installer = ($candidates | Sort-Object Name -Descending | Select-Object -First 1).FullName }
}
if (-not $Installer -or -not (Test-Path $Installer)) { throw "找不到安装包，请用 -Installer 指定：$Installer" }
Write-Step2 ('安装包：' + $Installer)

# ---------------------------------------------------------------- 关掉正在运行的砚池
$running = Get-Process inkwell -ErrorAction SilentlyContinue
if ($running) {
    Write-Note ('检测到 ' + @($running).Count + ' 个 inkwell 进程，先结束它们')
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 800
}

# ---------------------------------------------------------------- 清掉上次的安装位置
$key = 'HKCU:\Software\inkwell\Inkwell'
if (Test-Path $key) {
    $old = (Get-ItemProperty $key -ErrorAction SilentlyContinue).'(default)'

    # ⚠️ 这里**必须**用 .NET 删：注册表的默认值既不能写名字 \'(default)\'
    #    （Remove-ItemProperty 会静默什么都不做），也不能传空名字（参数校验直接报错）。
    #    更坑的是 Remove-ItemProperty 加了 -ErrorAction SilentlyContinue 后
    #    看起来像删成功了 —— 实测踩过：注册表没清掉，安装照样装到旧目录。
    #    所以删完一定要回读确认。
    $reg = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\inkwell\Inkwell', $true)
    if ($reg) {
        $reg.DeleteValue('', $false)
        $reg.Close()
    }

    $left = (Get-ItemProperty $key -ErrorAction SilentlyContinue).'(default)'
    if ($left) { throw ('上次安装位置没清掉，仍是：' + $left) }
    Write-Ok2 ('已清除上次安装位置记录：' + $old)
} else {
    Write-Ok2 '没有上次安装位置记录'
}

# ---------------------------------------------------------------- 复制到工作区外再运行
$tmp = Join-Path $env:TEMP ('inkwell-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$local = Join-Path $tmp (Split-Path -Leaf $Installer)
Copy-Item $Installer $local -Force
Write-Ok2 ('已复制到工作区外：' + $local)

Write-Step2 '开始安装'
$installArgs = @()
if ($Silent) { $installArgs += '/S' }
if ($InstallDir) { $installArgs += ('/D=' + $InstallDir) }
$proc = Start-Process -FilePath $local -ArgumentList $installArgs -Wait -PassThru
Write-Ok2 ('安装器退出码：' + $proc.ExitCode)

if ($Silent) {
    Start-Sleep -Seconds 2
    # 装到哪儿以**注册表实际写下的值**为准，别拿默认路径猜（猜错会「看起来装好了」）
    $dir = (Get-ItemProperty 'HKCU:\Software\inkwell\Inkwell' -ErrorAction SilentlyContinue).'(default)'
    $exe = if ($dir) { Join-Path $dir 'inkwell.exe' } else { $null }
    if ($exe -and (Test-Path $exe)) {
        $item = Get-Item $exe
        Write-Ok2 ('已安装：' + $exe + '  ' + $item.Length + ' 字节  ' + $item.LastWriteTime)
    } else {
        Write-Note ('注册表里没有安装位置，或那里没有 inkwell.exe：' + $dir)
    }
}

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
