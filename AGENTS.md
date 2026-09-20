# AGENTS.md

> 本文件是本仓库的 **Agent 协作说明书**：给 AI 编码代理（以及未来的自己）看的项目上下文。
> 任何自动化代理在本仓库动手前，必须先读完本文件与 `docs/IMPLEMENTATION_PLAN.md`。

---

## 1. 项目定位

| 项 | 内容 |
| --- | --- |
| 项目名 | **砚池**（英文 **Inkwell**） |
| 性质 | **个人自用**电子书阅读器。源码公开托管于 GitHub，但**不发版、不上架应用商店** |
| 实现路线 | **自研精简版**：自己写应用外壳，复用成熟渲染内核 |
| 技术栈 | Tauri v2 + Vite + React 19 + TypeScript；Rust 后端 + SQLite |
| 渲染内核 | **foliate-js（MIT）** —— 唯一复用的大型第三方内核 |
| 目标平台 | **Windows (x64)** 与 **Android (arm64)** |
| 语言 | 界面中文；与用户沟通、文档、提交信息一律用**中文** |
| 应用标识 | `com.inkwell.reader`（Windows identifier + Android applicationId） |
| 可执行文件 | `inkwell` |
| 数据目录 | `{AppData}/Inkwell/`（书库 `books/`、封面 `covers/`、库 `library.db`） |

> 注意：**仓库目录名与应用名不一致**（目录是仓库名，Inkwell 是产品名），别混淆。

### 1.1 与 Readest 的关系（重要）

本项目**不是 Readest 的 fork**，也**不复用 Readest 的任何代码**。

- Readest 的角色是**架构参考**：它证明了 foliate-js 在 Tauri 双端方案上可行。
- Readest 使用 **AGPL-3.0**；我们只用 **MIT 协议的 foliate-js**，因此本项目**不继承 AGPL 的传染性义务**。
- 遇到设计问题时，可以去读 Readest 源码找思路（`apps/readest-app/src/components/reader/` 很有参考价值），
  但**只能借鉴思路，不能复制代码**——AGPL 代码一旦进入本仓库，整个项目就被传染。

---

## 2. 全局铁律（MUST / MUST NOT）

1. **不复制 AGPL 代码**：Readest / Foliate(GTK) 的代码可以读、可以学思路，**绝不逐行照搬**。这是本仓库第一条红线。
2. **纯本地自用**：不接入遥测、不引入需要注册/付费的必需依赖、不做联网回传。
3. **渲染内核只在一个地方接触**：`src/features/reader/engine/` 是**唯一**允许 `import` foliate-js 的目录。
   其他任何地方都不许直接碰内核 API。理由见 §4.2。
4. **数据库只在 Rust 侧操作**：前端**不允许**写 SQL，一律通过 `invoke` 调 Rust command。
5. **密钥不进 WebView**：AI API Key 等敏感信息存 Rust 侧，请求由 Rust 发起，绝不放进前端代码或 localStorage。
6. **不引入不必要的东西**：能一行解决就不写十行；不加用不到的抽象、配置项、错误分支。
7. **未经验证不得宣称完成**：构建/运行类改动必须给出真实执行过的命令与输出，不允许"应该可以"。

---

## 3. 开发环境（本机实测状态）

> 最后核对时间：2026-09-19

| 组件 | 需要 | 本机现状 | 结论 |
| --- | --- | --- | --- |
| Node.js | ≥ 20.19（建议 24） | **v22.20.0** | ⚠️ 可用，建议升 24 |
| pnpm | 10+ | **11.8.0** | ✅ |
| Git | — | 2.45.1 | ✅ |
| JDK | 17+（Tauri 要求） | **21.0.8 Microsoft OpenJDK** | ✅ |
| WebView2 Runtime | 任意 | **153.0.4234.32** | ✅ |
| Rust / Cargo | 最新 stable-msvc | **1.98.1** | ✅ |
| MSVC C++ 生成工具 | VS 2022 Build Tools + "使用 C++ 的桌面开发" | **17.14 (BuildTools)** | ✅ |
| Android SDK | platform-tools / platforms;android-36 | **已装** | ✅ |
| Android NDK | r27 系列 | **27.3.13750724** | ✅ |
| Rust Android 目标 | 四个三元组 | **已全部添加** | ✅ |
| 磁盘可用空间 | ≥ 30 GB | **D: 剩余 235 GB** | ✅ |

> Android 上用到的额外组件：`build-tools;35.0.0` 与 `build-tools;37.0.0`
> （Gradle 的 AGP 会指定 35，Tauri 模板用 37，两者都留着），以及 `platforms;android-35`。

**环境已全部就绪，双端均可构建。**

### 3.1 环境相关的坑（已踩过，别重复踩）

| 现象 | 原因 | 应对 |
| --- | --- | --- |
| `pnpm install` 报 `EPERM mkdir ...\pnpm-cache` | pnpm 默认把 store/cache 放在工作目录之外，早期沙箱不允许写 | 曾重定向到仓库内，**现已移除**——那会写入本机绝对路径、换台机器就失效。pnpm 默认位置即可 |
| 构建报 `Error: spawn EPERM` | esbuild 以**管道 stdio** 启动常驻子进程 | 用完整访问权限执行构建命令 |
| PowerShell 5.1 把中文 `.ps1` 读成乱码 | 默认按 ANSI(GBK) 解析，需 **UTF-8 BOM** | 所有 `.ps1` 都已带 BOM；**`edit`/`write` 工具改写会把 BOM 吃掉**，改完必须用 `[System.IO.File]::WriteAllBytes` 前置 `EF BB BF` 补回，再用 `Parser::ParseFile` 验一遍语法 |
| 经代理访问 https 报 `SEC_E_NO_CREDENTIALS` | Windows schannel 在受限令牌下拿不到凭证 | 下载一律走 `personal/scripts/download.mjs`（Node + OpenSSL） |
| Java 工具（sdkmanager / Gradle）下载超时 | Java 的 HttpURLConnection 不读系统代理 | 给 Java 传 `JAVA_TOOL_OPTIONS=-Dhttps.proxyHost=...`；Gradle 发行包用 `fetch-gradle.mjs` 预置 |
| Android 构建报 `Creation symbolic link is not allowed` | Tauri 用符号链接放置 `.so`，需开发者模式 | 由 `src-tauri/tauri.js` 改为复制文件（**不要删这个文件**） |
| Android 链接报 `os error 193` | 用了无扩展名的 `*-clang`（bash 脚本） | Windows 上必须用 `.cmd` 变体 |
| 宿主 build script 报 `windows.h not found` | 把 NDK 的 `CC`/`CXX` 设成了**全局**变量 | 只设**目标限定**的 `CC_<triple>` 等，绝不设全局 |
| 阅读器报 `open is not a function` | foliate-js 靠 `customElements.define` 注册元素，而 `View` 只用于类型位置时打包器会删掉整条导入 | 保留副作用导入 `import 'foliate-js/view.js'`（engine/index.ts 内注释） |
| 封面全部不显示 | asset 协议只放行了 `books/`，封面在 `covers/` | `asset_protocol_scope` 两个目录都要放行 |
| 书库页白屏，报 React #185 | zustand 选择器每次返回新数组，引用永不相等 → 无限重渲染 | 选择器只收纯数据，组件侧用 `useMemo` 派生 |
| `biome format` 改写了 submodule | `files.includes` 未排除 `packages/`，把第三方源码全重排了 | includes 里已加 `!**/packages`；**别删这条** |
| 安装包装到奇怪的位置 | NSIS 的 `RestorePreviousInstallLocation` 会读注册表里上次的位置 | 删掉 `HKCU\Software\inkwell\Inkwell` 后重装 |
| **Gradle wrapper 说没有发行包、转去重新下载然后 `Read timed out`** | Java 的 `user.home` 取自 **Windows 用户配置目录**（进程令牌），**不读 `USERPROFILE` 环境变量**。若 shell 里的 `USERPROFILE` 与真实配置目录不一致，`fetch-gradle.mjs`（按 `USERPROFILE` 放）和 Gradle（按 `user.home` 找）就各说各话 | 显式设 `GRADLE_USER_HOME=<真实配置目录>\.gradle` 再跑 Gradle。同一台机器上 `LOCALAPPDATA` 也会影响 NSIS 缓存（`%LOCALAPPDATA%\tauri\NSIS`），出 Windows 包时同样要指对 |
| **Android 装不上，报 `packageinfo is null`** | 打出来的 APK **没有签名**（文件名带 `-unsigned`）。未签名在 Android 上是硬失败，不是「只提示未知来源」 | 配好 `src-tauri/gen/android/keystore.properties`；`build-android.ps1` 已加 `apksigner verify` 校验，未签名直接失败 |
| **Android 发布包一启动就报 `Failed to request http://localhost:1420/`** | 我们的 Android shim 只调 `cargo build --release`，没带官方 CLI 会加的 `custom-protocol` 特性 → tauri 的 `build.rs` 把 `dev` 置为 true → **不内嵌前端资源**，改去连 devUrl | `Cargo.toml` 的 `[features] custom-protocol` 与 `tauri.js` release 分支的 `--features custom-protocol` **两处都得留着**；`build-android.ps1` 已加硬性校验（从 APK 里解 `.so` 搜 `index-*.js`）。⚠️ 判据只能是 `index-*.js`，`localhost:1420` 字符串修复前后都在二进制里，拿它当判据会得出反结论 |
| **改了界面，重新出包装上去还是旧界面** | cargo **不跟踪 `dist/`**——`tauri-build` 只为 sidecar / resources / 配置文件声明 `rerun-if-changed`，所以前端变了不会重编 crate，旧资源继续内嵌 | `src-tauri/build.rs` 里的 `cargo:rerun-if-changed=../dist` **别删** |
| **Android 导入书报「文件不存在」，文件名还是一串 `%E5%BE%90...`** | Android 选择器走 SAF，交回来的是 `content://` URI（`tauri-plugin-dialog` 的 `DialogPlugin.kt:117` 直接给 `uri.toString()`），**不是文件路径**；`std::fs` 打不开它 | `import_books` 现在会先把 URI 落地成临时文件（走 `tauri-plugin-fs` 的 `Fs::open`，Android 上即原生 `ContentResolver`）。写导入/读取相关代码时，别默认「拿到的一定是路径」 |
| **Android 界面顶到状态栏；双指一捏整页缩到左上角** | Tauri 模板调了 `enableEdgeToEdge()`，但那只是「允许」edge-to-edge，**insets 得自己消费**；Android 15 起（targetSdk 35+）更是强制。WebView 的 pinch-zoom 也默认开着 | insets 在 `MainActivity.kt` 里挂 `android.R.id.content` 处理。⚠️ **CSS 的 `env(safe-area-inset-*)` 在 Android WebView 上只按「屏幕挖孔」上报**，不含状态栏高度，靠它顶不住 |
| **Android 上「划词后弹出来的东西」被系统菜单盖住** | 选中文字后 Android 会先弹**系统自己的**「复制 / 粘贴 / 网络搜索」浮层。那是**原生浮层**，永远贴着选区、且画在 WebView **之上** —— 不是 z-index 能解决的，浮在选区附近的任何 UI 都会被盖住 | 划词相关的 UI（批注操作栏，将来还有释义卡片）**一律贴屏幕底部**，别浮在选区旁边 |

---

## 4. 架构原则

### 4.1 分层

```
前端 (WebView)  ──  React 视图 / Zustand / UI
      │  Tauri IPC (invoke)
Rust 后端       ──  library / db / epub / ai / sync
      │
   SQLite (FTS5)
```

### 4.2 为什么 foliate-js 必须被 Adapter 隔离

foliate-js 官方 README 明确写了：**"It's not stable. Expect it to break and the API to change at any time."**

因此：

- `src/features/reader/engine/` 是唯一接触点，对外暴露**我们自定义的稳定接口**（如 `openBook()` / `goTo()` / `onRelocate()`）。
- 升级 foliate-js 时，只需改这一个目录。
- 内核以 **git submodule 固定 commit** 引入，不跟 `main` 飘。

### 4.3 目录结构

```
myEpubReader/                     # 仓库目录（应用名是 Inkwell，二者不同）
├── AGENTS.md                     # 本文件
├── docs/
│   ├── IMPLEMENTATION_PLAN.md    # 实现规划主文档
│   └── BACKLOG.md                # ★ 待办与已知问题（接手先看这份）
├── personal/                     # ★ 私有层
│   ├── config/app-identity.json  # 机器可读的应用标识
│   ├── scripts/
│   │   ├── setup-toolchain.ps1   # Rust + VS 生成工具（需管理员权限）
│   │   ├── setup-android.mjs     # Android SDK / NDK / Rust 目标
│   │   ├── fetch-nsis.mjs        # 预置 NSIS 打包工具链
│   │   ├── fetch-gradle.mjs      # 预置 Gradle 发行包
│   │   ├── download.mjs          # 通用下载器（绕开 schannel 故障）
│   │   ├── build-win.ps1         # Windows 一键出包
│   │   ├── build-android.ps1     # Android 一键出包
│   │   ├── cdp.mjs               # 用 CDP 驱动真实应用做验证（见 §5.4）
│   │   └── tauri.mjs             # ★ Tauri CLI 包装器，必须经它调用
│   └── notes/                    # 环境备忘、安装日志
├── packages/foliate-js/          # 【阶段 1 引入】submodule，固定 commit
├── src/                          # 前端（Vite + React）
│   ├── App.tsx                   # 阶段 0 骨架页（阶段 1 换成书库）
│   ├── main.tsx  vite-env.d.ts
│   ├── styles/globals.css        # Tailwind 入口 + 主题变量
│   └── (阶段 1 起) routes/ features/ components/ store/ lib/ types/
├── src-tauri/                    # Rust 后端
│   ├── tauri.js                  # ★ Gradle Rust 任务的适配层（勿删）
│   ├── src/lib.rs                # Tauri builder + app_info command
│   ├── src/main.rs               # 入口
│   ├── capabilities/default.json # 权限集
│   ├── icons/                    # 全平台图标（tauri init 生成）
│   ├── Cargo.toml  tauri.conf.json  build.rs
│   └── (阶段 1 起) src/{db,library,epub,annotation,ai,sync}/
├── index.html  package.json  pnpm-workspace.yaml
├── tsconfig.json  vite.config.ts  biome.json
└── .npmrc  .gitignore  .gitattributes
```

> `src/routes/features/...` 等子目录要到阶段 1 才会创建，现在不存在是正常的。

---

## 5. 常用命令

> 阶段 0 完成后才可用。骨架尚未搭建时以下命令会失败。

### 5.0 项目进度（2026-09-20）

| 阶段 | 状态 |
| --- | --- |
| 阶段 0：环境与骨架 | ✅ 完成（双端出包跑通） |
| 阶段 1：MVP 阅读器 | ✅ 完成，**用户已验收通过** |
| 阶段 2：中文化 + 批注 + 搜索 | 🔄 进行中：中文排版 ✅、批注 ✅（高亮/笔记/书签/导出）、Android 真机适配 ✅；中文字体 / 简繁转换 / 全文搜索待做 |
| 阶段 3 及以后 | ⏸️ 未开始 |

**阶段 1 已交付的能力**：书库（导入/封面/搜索/排序/删除）、阅读器
（目录跳转、翻页与滚动、滚轮与点按与方向键翻页、CFI 精确进度）、阅读设置
（字号/行距/边距/字体/主题/分栏）。

**阶段 2 已交付**：

- **中文排版** —— 首行缩进 2 字、行首禁则、中西文自动间距与标点挤压，自动 / 开 / 关三档（§3.1）
- **批注** —— 划词高亮（四色）、笔记、书签、侧栏列表与跳转、导出 Markdown / JSON；
  书签还支持「下拉手势」（翻页模式下下拉过 96px 松手即切换）（§3.4）

**已修复**：

- 翻页模式下的鼠标滚轮翻页（`docs/BACKLOG.md` §2.1）
- Android 发布包一启动就报 `Failed to request http://localhost:1420/`（`docs/BACKLOG.md` §2.2）
- Android 导入书报「文件不存在」（SAF 的 `content://` URI，§2.4）
- Android 界面顶到状态栏、双指缩放把整页缩小（§2.5）

> ✅ 上面四条已于 **2026-09-20 在真机（Redmi K90）验收通过** ——
> 安卓端至此才算真的能用。后续改 Android 相关代码时，别把这三类问题改回去。

**实测产物**（`personal/out/` 下有副本）：

| 产物 | 路径 | 大小 |
| --- | --- | --- |
| Windows 安装包 | `src-tauri/target/release/bundle/nsis/Inkwell_0.1.0_x64-setup.exe` | 2.66 MB |
| Android APK（arm64，手机用） | `src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk` | 10.5 MB |
| Android APK（universal，全架构） | 同上目录 `universal/release/` | 33.8 MB |

> 🔐 **已签名**：Android 发布包用 `personal/keystore/inkwell.jks` 签名（证书与密码都已 gitignore，
> 凭据另存于 `personal/keystore/credentials.txt`）。
>
> ⚠️ **未签名的 APK 是「装不上」，不是「只提示未知来源」**——安装器的 `getPackageArchiveInfo()`
> 返回 null，用户只会看到 `packageinfo is null`。这是真踩过的坑：0.1.0 首次发布的两份 APK
> 就是未签名的，下载后完全无法安装。`build-android.ps1` 现在会用 `apksigner verify` 硬性校验，
> 未签名直接 `exit 1`，不再放行。
>
> 📄 **下一步做什么、已知问题怎么修，一律看 `docs/BACKLOG.md`** —— 不要凭印象开工。

> **Tauri CLI 注意**：必须经 `personal/scripts/tauri.mjs` 包装器调用（见 §3.1 与文件内注释）。
> 用 `pnpm tauri <子命令>`，**不要写 `pnpm tauri -- <子命令>`** —— pnpm 11 会把 `--` 原样传给 CLI 导致报错。

### 5.1 依赖与准备

```bash
pnpm install                              # 安装依赖
```

### 5.2 开发

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 只跑前端（Vite，毫秒级热更新，改 UI 用这个） |
| `pnpm tauri dev` | Windows 桌面开发（会编译 Rust，首次 20–40 分钟） |
| `pnpm tauri android dev --host` | Android 真机开发 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` / `pnpm format` | Biome 检查 / 格式化 |
| `cargo test` | Rust 测试 |
| `cargo clippy -- -D warnings` | Rust lint |

### 5.3 出包

| 命令 | 产物 |
| --- | --- |
| `personal/scripts/build-win.ps1` | Windows NSIS 安装包 ✅ 已实测 |
| `personal/scripts/build-android.ps1` | Android APK（`-Install` 可直接装到手机） ✅ 已实测 |
| `pnpm tauri info` | 环境自检（有问题先跑这个） |

**环境准备脚本**（各跑一次即可，幂等）：

| 命令 | 用途 |
| --- | --- |
| `personal/scripts/setup-toolchain.ps1` | Rust + VS 生成工具（**需管理员**） |
| `personal/scripts/setup-android.mjs` | Android SDK / NDK / Rust 目标 |
| `personal/scripts/fetch-nsis.mjs` | 预置 NSIS 打包工具链 |
| `personal/scripts/fetch-gradle.mjs` | 预置 Gradle 发行包 |

> 关于 `src-tauri/tauri.js`：这是必需的适配层，不是临时文件。
> Gradle 的 Rust 任务会回调它来编译 .so；它同时绕开了 Windows 符号链接限制。**不要删除。**

### 5.4 用 CDP 驱动真实应用做验证（强烈推荐）

界面类改动**光看构建通过远远不够**。WebView2 支持远程调试，可以像操作浏览器一样
驱动真实应用；实测一轮就抓出了三个「界面能打开、功能全废」的 bug。

```powershell
# 1) 带调试端口启动（要让进程常驻，例如放进后台作业）
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
& "$env:LOCALAPPDATA\Inkwell\inkwell.exe"

# 2) 另开终端列出调试目标
Invoke-WebRequest http://127.0.0.1:9222/json -UseBasicParsing
```

再用 Node（22 起自带 `WebSocket`）连上 `webSocketDebuggerUrl`，
发 `Runtime.evaluate` 就能读 DOM、点按钮、取应用内部状态。
**这一步已经有现成脚本，不用每次现写**：

```powershell
node personal/scripts/cdp.mjs "document.title"
node personal/scripts/cdp.mjs "location.hash = '#/read/<bookId>'; 'ok'"
node personal/scripts/cdp.mjs "document.querySelector('footer input[type=range]').value"
```

> ⚠️ foliate-js 的 View 与 Paginator 都用 `attachShadow({mode:'closed'})`，
> **影子树读不到**。但 `book` / `lastLocation` / `renderer` 是公开属性，
> 且 `renderer.getContents()` 能拿到书籍文档，据此足以判断书籍是否真的
> 加载成功、排版是否真的生效：
>
> ```js
> const v = document.querySelector('foliate-view');
> const doc = v.renderer.getContents()[0].doc;
> doc.defaultView.getComputedStyle(doc.querySelector('p')).textIndent;
> ```
> 
> ⚠️ 子进程会随 pwsh 会话结束被回收，必须用后台作业让应用常驻，否则 CDP 连不上。

---

## 6. 编码规则

- **TypeScript strict**，`pnpm typecheck` 必须零错误。
- **Biome** 负责格式化与 lint，不要手写与之冲突的风格。
- **Rust**：`cargo fmt` + `cargo clippy -- -D warnings` 必须干净。
- **SQLite**：schema 变更必须写成迁移文件，**不允许**手改表结构。
- **UI**：直接复用 `components/` 里已有组件；不要为一次性场景造新抽象。
- **中文排版**：涉及排版逻辑时注意 `lang="zh"` 下的断行与标点规则。
- **测试**：修 bug 先写能复现的测试；数据层与 EPUB 解析必须有单测。
- **提交**：一个提交只做一件事，中文提交信息，格式 `类型: 摘要`（feat/fix/docs/chore/refactor/perf）。

---

## 7. 需要先问用户的情况

遇到以下决定，**停下来问**，不要自作主张：

1. 需要引入新的第三方依赖或服务（尤其是非 MIT/Apache 协议的）。
2. 需要修改应用标识（产品名、`identifier`、Android 包名、图标）。
3. 需要改动数据表结构且涉及已有数据。
4. 涉及签名证书、删除用户数据等不可逆操作。
5. 发现某功能需要的工作量明显超出当前阶段预期。

---

## 8. 参考资料

- **待办与已知问题**：`docs/BACKLOG.md` ← 继续开发前必看
- 实现规划：`docs/IMPLEMENTATION_PLAN.md`
- 渲染内核：https://github.com/johnfactotum/foliate-js （MIT）
- Tauri v2：https://v2.tauri.app/
- 架构参考（**只读思路，勿抄代码**）：https://github.com/readest/readest （AGPL-3.0）
