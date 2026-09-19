# 阶段 0 环境备忘

记录日期：2026-09-19

## 一、本机实测环境

| 组件 | 版本 / 状态 |
| --- | --- |
| OS | Windows 10.0.26200 (x86_64) |
| WebView2 Runtime | 153.0.4234.32 ✅ |
| JDK | Microsoft OpenJDK 21.0.8，`JAVA_HOME=%USERPROFILE%\sdk\.jdks\ms-JDK21` ✅ |
| Node.js | v22.20.0（系统 PATH），另有 DSH 自带 node 24.18.1 |
| pnpm | 11.8.0 |
| yarn / npm | 1.22.22 / 10.9.3 |
| Git | 2.45.1 |
| Rust / Cargo | ❌ 未安装 |
| VS 2022 生成工具 | ❌ 未安装 |
| Android SDK / NDK / adb | ❌ 未安装 |

`pnpm tauri info` 实测输出（节选）：

```
[✘] Environment
    - OS: Windows 10.0.26200 x86_64 (X64)
    ✔ WebView2: 153.0.4234.32
    ✘ Couldn't detect any Visual Studio or VS Build Tools instance with MSVC and SDK components.
    ✘ rustc: not installed!
    ✘ Cargo: not installed!
    ⚠ rustup: not installed!
    - node: 24.18.1
    - pnpm: 11.8.0
[-] Packages
    - tauri 🦀: 2.11.3, (outdated, latest: 2.11.5)
    - @tauri-apps/api  ⱼₛ: 2.11.1
    - @tauri-apps/cli  ⱼₛ: 2.11.4
```

## 二、三个必须记住的坑

### 1. pnpm 的 store / cache 必须留在仓库内

DSH 的文件沙箱只允许写入本项目目录。pnpm 默认写到
`%LOCALAPPDATA%\pnpm-store` 与 `pnpm-cache`，会直接 `EPERM` 失败。

解决：`pnpm-workspace.yaml` 与 `.npmrc` 同时把 `storeDir` / `cacheDir` 指向仓库内的
`.pnpm-store` / `.pnpm-cache`（已在 `.gitignore` 排除）。

### 2. esbuild 需要管道 stdio，受限沙箱下必然 `spawn EPERM`

Vite 依赖 esbuild，esbuild 以**管道 stdio** 启动一个常驻子进程做转译。
受限沙箱禁止命名管道 ⇒ `Error: spawn EPERM`，任何构建都跑不起来。

解决：
- **构建类命令一律以 `danger-full-access` 提权执行**；
- esbuild 的 postinstall 也因同样原因失败，但它只做二进制校验，
  真正的 `esbuild.exe` 由平台可选依赖 `@esbuild/win32-x64` 提供，
  故在 `pnpm-workspace.yaml` 的 `allowBuilds` 中把 `esbuild` 设为 `false` 即可。

### 3. Tauri CLI 的 argv 探测在 Electron 宿主下会误判

`@tauri-apps/cli/tauri.js` 第 23 行用 `process.argv[0]` 的文件名判断宿主是否
`node|nodejs|bun|electron`。DSH 下 `argv[0]` 是 `D:\tool\DSH Desktop\DSH Desktop.exe`，
匹配不上，脚本就把该路径当成子命令塞回去，报
`error: unrecognized subcommand 'D:\tool\DSH Desktop\DSH Desktop.exe'`。

解决：用 `personal/scripts/tauri.mjs` 包装器直接调 `@tauri-apps/cli/main.js`，
不猜宿主。`package.json` 的 `tauri` 脚本已指向它。

**另外**：调用时写 `pnpm tauri <子命令>`，**不要加 `--`**（pnpm 11 会把 `--` 原样传给 CLI）。

### 4. `Start-Process -ArgumentList` 会破坏含空格的参数（重要）

首次安装时 VS 生成工具**在 1 秒内就失败**了，日志里是 `winget` 返回
`0x8A150002`。这个码的含义是 **「命令行参数无效」**，不是网络问题。

原因：`Start-Process -ArgumentList` 接受数组时会**用空格把数组拼成一个字符串**，
于是 `--override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools"`
里那段带空格的字符串被拆成了好几个参数，winget 直接拒绝执行。

**正确写法**是用 `&` 展开数组，PowerShell 会逐个正确转义：

```powershell
& $exe @argv        # 正确
Start-Process -ArgumentList $argv   # 错误：含空格的参数会被拆坏
```

`Invoke-External` 已按正确写法实现。另外 VS 生成工具现在直接用**仓库内预下载的
官方引导程序** `personal/tools/vs_BuildTools.exe` 安装，完全绕开 winget 的参数转义问题。

### 5. 经代理访问 https 时 schannel 会失败，改用 Node 下载

`Invoke-WebRequest` 与 `curl.exe` 在本机全部失败：

```
curl: (35) schannel: AcquireCredentialsHandle failed:
          SEC_E_NO_CREDENTIALS (0x8009030e)
```

注意带上本地代理时**隧道是通的**（能看到
`HTTP/1.1 200 Connection established`），挂在 TLS 握手那一步 —— 即
Windows 的 schannel 在"受限令牌"下拿不到凭证。**这是我这个 Agent 沙箱的问题，
不是用户机器的问题**（用户的 winget 能正常下载 Rust 就是证明）。

**Node 自带 OpenSSL，且会自动读取系统代理，实测完全可用**：

```bash
node personal/scripts/download.mjs <url> <目标路径>
```

脚本里所有下载（rustup-init、VS 引导程序、Android cmdline-tools）都已改走 Node。
**结论：以后凡是需要联网下载，都用 `download.mjs`，不要用 `Invoke-WebRequest`。**

### 6. `.gitignore` 的行尾注释无效

```
personal/tools/          # 注释        <-- 错误！# 后面整串会被当成路径的一部分
```

gitignore **不支持行尾注释**，`#` 必须独占一行。上面这条规则实际不生效，
导致 4.27MB 的 `vs_BuildTools.exe` 被误提交（已用 `git rm --cached` 移出并修正规则）。

### 7. PowerShell 脚本必须带 UTF-8 BOM

Windows PowerShell 5.1 默认按 ANSI(GBK) 读取 `.ps1`，含中文的脚本会变成乱码并报一堆
「缺少右括号」之类的假语法错误。`setup-toolchain.ps1` 已带 BOM（前 3 字节 `EF BB BF`）。
**以后用工具改写该文件后，记得重新补 BOM。**
