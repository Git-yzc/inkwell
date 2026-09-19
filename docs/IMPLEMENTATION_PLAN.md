# 砚池 (Inkwell) 实现规划与开发方案

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.2（阶段 0/1 已完成） |
| 编写日期 | 2026-09-19 |
| 状态 | ✅ 阶段 0 与阶段 1 已完成并验收；阶段 2 起暂停，任务清单见 `docs/BACKLOG.md` |
| 决策依据 | 已确认：形态 = **自研精简版**；名称 = **砚池 (Inkwell)**；云同步 = **完全本地化**；界面语言 = **仅中文**；顺序 = **先 Windows 后 Android**；功能 = 构建跑通优先 + 中文化 + 词典翻译 + AI 助手 + 书库本地同步 + 界面品牌化 + 阅读统计 |

---

## 一、结论先行（TL;DR）

**要做什么**：一个**自研的、轻量的、纯本地的**电子书阅读器，Windows 与 Android 双端，只给你自己用。

**怎么做**（一句话）：**自己写应用外壳，复用成熟的渲染内核。**
外壳用 **Tauri v2 + Vite + React 19 + TypeScript**；EPUB 等格式的**排版渲染内核直接复用 `foliate-js`（MIT 协议）**——这是 Readest 和 Linux 版 Foliate 共同的底层引擎。

**不做什么**：

- ❌ 不自己写 EPUB 解析与分页排版引擎（那是数月级工作量，且做不过成熟库）
- ❌ 不使用 Next.js / 云同步 / 账号体系 / 遥测上报
- ❌ 不复用 Readest 的应用层代码（那是 AGPL-3.0，且与我们的精简目标相悖）

**工期概览**（按"能跑通 → 能看书 → 好用"三段推进）：

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| **阶段 0** | 工具链安装 + 项目骨架 + **Windows/Android 双端出包跑通** | 1–2 天（含下载等待） |
| **阶段 1** | **MVP 阅读器**：书库 + 导入 EPUB + 阅读 + 进度保存 | 1–2 周 |
| **阶段 2** | 中文化排版 + 批注 + 全文搜索 | 1–2 周 |
| **阶段 3** | 本地词典 + 划词翻译 | ~1 周 |
| **阶段 4** | AI 助手 + 阅读统计 | ~1 周 |
| **阶段 5**（可选） | Windows ↔ Android 本地同步 | ~1 周 |

> **重要承诺**：阶段 1 结束时你会拿到一个**真的能用来读书**的双端 App。
> ✅ **已兑现**（2026-09-19）：Windows 与 Android 均已出包，用户验收通过。
> 后续任务的落地清单与已知问题已移至 `docs/BACKLOG.md`，本文档保留整体规划视角。

---

## 二、技术选型论证

### 2.1 为什么是"自研外壳 + 复用内核"

你选择了自研精简版。这里有一个关键判断：**电子书阅读器的难点不在界面，在排版内核。**

一个 EPUB 渲染引擎需要处理：ZIP/OCF 容器解析 → OPF spine/manifest → XHTML + CSS 分页 → CFI 定位（`epubcfi(/6/14!/4/2/2)` 这种精确定位语法）→ iframe 沙箱 → 字体混淆解密 → 竖排/横排 → 批注层叠加。这是数千小时的产物。

**`foliate-js` 已经把这些做完了，而且是 MIT 协议**——可以自由使用、修改、闭源，没有任何传染性。它在 Linux 版 Foliate 的稳定版本中已经用了多年，Readest 也是基于它二次开发的。

所以正确的分工是：

| 层 | 谁来做 | 说明 |
| --- | --- | --- |
| 排版渲染内核 | **复用 foliate-js**（MIT） | 我们**不碰**，只做适配封装 |
| 应用外壳 / 交互 / 数据 / 平台集成 | **我们自己写** | 这是我们真正要"自研"的部分 |

这样既是"自研"，又不会掉进"重造轮子"的坑。

### 2.2 候选方案对比（诚实版）

| 方案 | 工期 | 可控性 | 功能完整度 | 结论 |
| --- | --- | --- | --- | --- |
| **自研外壳 + foliate-js 内核**（本方案） | 1–2 月达到好用 | 高 | 高（可逐步补齐） | ✅ **采用** |
| Fork Readest 全量源码 | 首次跑通 2–3 天，改功能快 | 中（改上游代码要不断合并） | 开箱即用（约 95%） | 备选，随时可切回 |
| 从零写渲染引擎 | 6 个月+ | 极高 | 低 | ❌ 不现实 |
| Electron / Flutter | — | — | — | ❌ Electron 包体 100MB+、安卓体验差；Flutter 要重写 foliate-js 生态 |

**说实话**：如果你只想要"立刻能用的阅读器"，Fork Readest 是更快的路径。你选了自研，我按自研规划，但我把**切回 Fork 的退路**明确保留在阶段 1 结束时。

### 2.3 为什么不用 Next.js（与 Readest 的关键差异）

Readest 用 Next.js 16，是因为他们**还要发布网页版**（部署在 Cloudflare Workers 上）。

我们只做 Windows + Android 两个原生 App，**不需要 SSR、不需要服务端渲染、不需要 SEO**。Next.js 在这个场景下带来的是：编译更慢、配置更复杂、产物更大、调试链路更长。

**Vite 7 + React 19 SPA** 启动是毫秒级的，改一行代码立刻热更新，构建产物就是一个静态目录，直接喂给 Tauri。对我们的场景是压倒性优势。

### 2.4 许可证合规

| 组件 | 许可证 | 对我们的影响 |
| --- | --- | --- |
| **foliate-js** | **MIT** | ✅ 自由使用，无义务 |
| Tauri v2 | MIT / Apache-2.0 | ✅ |
| React / Vite / Tailwind / Radix / Zustand | MIT | ✅ |
| 上游 Readest 代码 | AGPL-3.0 | ⚠️ **我们不复用它，因此不受其约束** |
| opencc-js / jieba-wasm / js-mdict | MIT / Apache-2.0 | ⚠️ 落地前逐个复核 |

**结论**：本方案产出的软件**不继承 AGPL 义务**，纯个人自用更无任何分发问题。

> 注：`foliate-js` 的 README 明确写了"It's not stable. Expect API to change"。因此我们**以 git submodule 固定到某个 commit**，并在其上包一层 `engine adapter`，把 API 变动隔离在一个文件里。

---

## 三、总体架构

### 3.1 应用标识（已锁定）

| 项 | 值 | 用途 |
| --- | --- | --- |
| 中文显示名 | **砚池** | 界面上的应用名 |
| 英文名 / 产品名 | **Inkwell** | Windows 产品名、窗口标题、安装包名 |
| 应用标识 identifier | `com.inkwell.reader` | Windows 注册表项 + Android applicationId |
| 可执行文件名 | `inkwell` | Tauri `mainBinaryName` |
| 安装包名 | `Inkwell_<版本>_x64-setup.exe` | NSIS 产物 |
| 数据根目录 | `{AppData}/Inkwell/` | Android 为应用私有目录 |
| 书库目录 | `{AppData}/Inkwell/books/` | 书籍文件本体 |
| 封面目录 | `{AppData}/Inkwell/covers/` | 封面缩略图 |
| 数据库 | `{AppData}/Inkwell/library.db` | SQLite（含 FTS5） |
| 界面语言 | `zh-CN`，仅中文 | |

> Windows 上 `{AppData}` = `%APPDATA%`，即 `C:\Users\<用户名>\AppData\Roaming`。

### 3.2 技术栈清单

| 层 | 选型 | 版本 | 备注 |
| --- | --- | --- | --- |
| 应用框架 | **Tauri v2** | CLI 2.11.4 / API 2.11.1 | 双端同构，产物小（安装包约 10–15MB） |
| 前端构建 | **Vite** | 7.x | 替代 Next.js |
| UI 框架 | **React** | 19.x | |
| 语言 | **TypeScript** | 5.x | strict 模式 |
| 样式 | **Tailwind CSS** | 4.x | 原子化，配合主题变量 |
| 组件基元 | **Radix UI** | 最新 | 无样式无障碍组件 |
| 图标 | **lucide-react** | 最新 | |
| 状态管理 | **Zustand** | 5.x | 轻量，无样板 |
| 路由 | **React Router** | 7.x（Hash 模式） | 兼容 Tauri 的 `tauri://` 协议 |
| 数据库 | **SQLite**（rusqlite `bundled` + FTS5） | 最新 | 编译进二进制，安卓无需额外依赖 |
| 渲染内核 | **foliate-js** | 固定 commit（submodule） | MIT，EPUB/MOBI/AZW3/FB2/CBZ/PDF |
| 简繁转换 | **opencc-js** | 最新 | 纯 JS，含词典 |
| 中文分词 | **jieba-wasm** | 最新 | 全文搜索用 |
| 词典 | **js-mdict** | 最新 | MDict `.mdx` 解析 |

**Rust 侧插件**：`tauri-plugin-fs`（文件）、`tauri-plugin-dialog`（选择文件）、`tauri-plugin-opener`（外部打开）、`tauri-plugin-os`、`tauri-plugin-log`、`tauri-plugin-clipboard-manager`、`tauri-plugin-deep-link`（Windows 文件关联）。

### 3.3 架构分层

```
┌──────────────────────────────────────────────────────────────┐
│  前端（WebView：Windows WebView2 / Android System WebView）   │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌──────────┐  ┌─────────┐  │
│  │  书库视图   │  │  阅读器视图 │  │ 词典/AI  │  │  设置   │  │
│  └─────┬──────┘  └─────┬──────┘  └────┬─────┘  └────┬────┘  │
│        │               │              │             │        │
│  ┌─────▼───────────────▼──────────────▼─────────────▼────┐  │
│  │              Zustand Store（全局状态）                  │  │
│  └─────────────────────┬─────────────────────────────────┘  │
│                        │                                     │
│  ┌─────────────────────▼─────────────────────────────────┐  │
│  │   Reader Engine Adapter  ← 隔离 foliate-js API 变动    │  │
│  │   （foliate-js View / Overlayer / Search）             │  │
│  └───────────────────────────────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────┘
                            │  Tauri IPC (invoke)
┌───────────────────────────▼──────────────────────────────────┐
│  Rust 后端（src-tauri）                                        │
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────┐ │
│  │ library  │ │  epub    │ │   db     │ │  ai    │ │ sync │ │
│  │ 导入/去重 │ │ OPF解析  │ │ rusqlite │ │ 代理   │ │      │ │
│  └──────────┘ └──────────┘ └────┬─────┘ └────────┘ └──────┘ │
│                                 │                            │
│                        ┌────────▼────────┐                   │
│                        │  SQLite (FTS5)  │                   │
│                        └─────────────────┘                   │
└──────────────────────────────────────────────────────────────┘
```

**关键设计点**：

1. **Rust 侧持有数据库**：前端不写 SQL。所有数据操作通过 `invoke` 调 Rust command。好处：事务可控、FTS5 可用、能写 `cargo test`、前端换 UI 不影响数据层。
2. **Adapter 隔离内核**：`src/features/reader/engine/` 是唯一 import foliate-js 的地方。将来升级 foliate-js 导致 API 变化，只改这一层。
3. **AI 密钥不进 WebView**：API Key 存在 Rust 侧（加密文件），请求由 Rust 发起。避免密钥出现在前端内存/日志中。

### 3.4 目录结构

```
myEpubReader/                     # 仓库目录（应用名是 Inkwell，二者不同）
├── AGENTS.md                     # Agent 协作说明书
├── docs/IMPLEMENTATION_PLAN.md   # 本文件
├── personal/                     # 私有定制层（构建脚本、补丁台账）
├── packages/
│   └── foliate-js/               # 【submodule，固定 commit】渲染内核
├── src/                          # ★ 前端（Vite + React）
│   ├── main.tsx
│   ├── App.tsx
│   ├── routes/
│   │   ├── library/              # 书库页
│   │   ├── reader/               # 阅读页
│   │   └── settings/             # 设置页
│   ├── features/
│   │   ├── reader/engine/        # ★ foliate-js 适配层（唯一接触点）
│   │   ├── reader/               # 阅读器 UI（TOC/工具条/进度）
│   │   ├── annotation/           # 高亮、笔记、书签
│   │   ├── dictionary/           # 词典查询
│   │   ├── translation/          # 翻译
│   │   ├── ai/                   # AI 助手面板
│   │   ├── stats/                # 阅读统计
│   │   └── chinese/              # 简繁转换、中文排版
│   ├── components/               # 通用 UI 组件
│   ├── store/                    # Zustand stores
│   ├── lib/                      # invoke 封装、工具函数
│   ├── styles/                   # Tailwind + 主题变量
│   └── types/
├── src-tauri/                    # ★ Rust 后端
│   ├── src/
│   │   ├── main.rs / lib.rs
│   │   ├── db/                   # 连接、迁移、查询
│   │   ├── library/              # 导入、去重、封面
│   │   ├── epub/                 # OPF/元数据解析
│   │   ├── annotation/
│   │   ├── ai/                   # AI 请求代理
│   │   └── sync/                 # 阶段 5
│   ├── capabilities/             # Tauri 权限配置
│   ├── icons/
│   └── tauri.conf.json
├── package.json
└── vite.config.ts
```

### 3.5 数据库设计（SQLite）

```sql
-- 书籍主表
CREATE TABLE books (
  id              TEXT PRIMARY KEY,          -- uuid v4
  title           TEXT NOT NULL,
  author          TEXT,
  series          TEXT,
  series_index    REAL,
  language        TEXT,
  publisher       TEXT,
  identifier      TEXT,                      -- ISBN 等
  format          TEXT NOT NULL,             -- epub/mobi/azw3/pdf/cbz/fb2/txt/md
  file_path       TEXT NOT NULL,             -- 相对「书库目录」的路径
  file_size       INTEGER,
  file_hash       TEXT,                      -- sha256 前 16 位，导入去重
  cover_path      TEXT,                      -- 相对「封面目录」的路径
  added_at        INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_opened_at  INTEGER,
  progress_cfi    TEXT,                      -- 上次阅读位置（EPUB CFI）
  progress_pct    REAL DEFAULT 0,            -- 0.0 ~ 1.0
  finished        INTEGER DEFAULT 0
);
CREATE INDEX idx_books_hash    ON books(file_hash);
CREATE INDEX idx_books_opened  ON books(last_opened_at DESC);

-- 书架（分类）
CREATE TABLE shelves (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE book_shelves (
  book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, shelf_id)
);

-- 批注
CREATE TABLE annotations (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                  -- highlight / note / bookmark
  cfi        TEXT NOT NULL,
  text       TEXT,                           -- 被划线的原文
  note       TEXT,                           -- 用户写的笔记
  color      TEXT,
  chapter    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ann_book ON annotations(book_id, created_at DESC);

-- 阅读会话（统计的基础数据）
CREATE TABLE reading_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  duration_sec INTEGER DEFAULT 0,
  chars_read   INTEGER DEFAULT 0
);

-- 设置（键值对）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 全文索引（阶段 2 使用）
CREATE VIRTUAL TABLE book_text_fts USING fts5(
  book_id UNINDEXED,
  cfi     UNINDEXED,
  text,
  tokenize = 'unicode61'
);
```

数据库文件位置：`{AppData}/Inkwell/library.db`（Android 为应用私有目录）。

### 3.6 关键数据流

**导入一本书**：

```
用户选文件 / 拖拽 / Android 选择器
      ↓
[前端] invoke('import_books', { paths })
      ↓
[Rust] 逐个处理：
  1. 算 sha256 → 查重（已存在则跳过并提示）
  2. 拷贝到 {书库目录}/{uuid}.epub
  3. 用 zip + quick-xml 读 META-INF/container.xml → OPF
  4. 提取 title / author / language / cover
  5. 封面图转 webp 存到 {封面目录}/{uuid}.webp
  6. 写入 books 表（事务）
      ↓
[前端] 收到导入结果 → 刷新书库列表
```

**打开一本书**：

```
[前端] 用户点书 → 拿到 book 记录
      ↓
[Adapter] 把文件路径转成 Tauri asset URL → view.open(url)
      ↓
[foliate-js] 解析 + 分页渲染进 iframe
      ↓
[Adapter] 监听 relocate 事件 → 得到当前 CFI + 百分比
      ↓
[前端] 节流 3 秒 → invoke('save_progress', { bookId, cfi, pct })
      ↓
[Rust] 更新 books 表 + 累加 reading_sessions
```

---

## 四、阶段 0 详解：环境与骨架（先跑通，再谈功能）

> 你选了"授权自动安装，先 Windows 后 Android"。这里必须如实说明一个限制：

### ⚠️ 关于"自动安装"的实话

**自动化代理运行在一个受限沙箱里，只能写入本项目目录，无法静默安装系统级软件。**（winget / MSI 安装需要管理员权限并写入 `C:\Program Files`）

**所以实际做法是**：

1. 我生成一个**一键安装脚本** `personal/scripts/setup-toolchain.ps1`
2. 脚本会：检测已装组件 → 用 winget 安装缺失部分 → 配置环境变量 → 逐项验证
3. **你需要做的**：以**管理员身份**打开 PowerShell 运行它，期间可能需要点几次确认
4. 装完后我接管，负责项目骨架、编译、出包

这是唯一可行的路径，也是最省你精力的路径（你只需要运行一条命令）。

### 4.1 需要安装的组件

| 组件 | 用途 | 安装方式 | 下载量 |
| --- | --- | --- | --- |
| **Rust (rustup + stable-msvc)** | 编译 Tauri 后端 | `winget install Rustlang.Rustup` | ~300 MB |
| **VS 2022 Build Tools + C++ 工作负载** | Rust 的 MSVC 链接器 | `winget install Microsoft.VisualStudio.2022.BuildTools` | **~6 GB** |
| **Node.js 24**（当前 22，建议升级） | 前端构建 | `winget install OpenJS.NodeJS.LTS` | ~30 MB |
| **Android SDK cmdline-tools + platform-tools** | Android 构建与部署 | 下载 zip 解压 | ~500 MB |
| **Android NDK** | Rust 交叉编译到 Android | sdkmanager | **~2.5 GB** |
| **Android platform 35 + build-tools 35** | Android 构建 | sdkmanager | ~400 MB |
| **Rust Android targets** | 交叉编译目标 | rustup | ~200 MB |

**合计约 10–15 GB 下载，建议预留 30 GB 磁盘。**

> ❓ **待确认**：你 D 盘剩余空间是否 ≥ 30 GB？（我的检测命令被沙箱拦了，需要你告诉我）

### 4.2 骨架搭建任务

| # | 任务 | 产出 |
| --- | --- | --- |
| 0.1 | `pnpm create tauri-app` 生成 Vite + React + TS 骨架 | 可运行的空壳 |
| 0.2 | 接入 Tailwind 4、Radix、Zustand、React Router | 样式与状态的底子 |
| 0.3 | 配置 `tauri.conf.json`（产品名、identifier、窗口尺寸、Android minSdk 26） | 应用身份 |
| 0.4 | 加 `foliate-js` 为 git submodule 并固定 commit | 渲染内核就位 |
| 0.5 | 写 `personal/scripts/build-win.ps1` | 一键出 Windows 包 |
| 0.6 | **Windows 跑通** `pnpm tauri dev` → 出 NSIS 安装包 | ✅ 里程碑 1 |
| 0.7 | 配置 Android 环境变量，`pnpm tauri android init` | Android 工程生成 |
| 0.8 | **Android 跑通** `pnpm tauri android dev --host` 真机 → 出 APK | ✅ 里程碑 2 |

### 4.3 阶段 0 验收标准（2026-09-19 实测结果）

| # | 验收项 | 结果 |
| --- | --- | --- |
| 1 | `pnpm tauri info` 全绿，无 ❌ | ✅ 通过：WebView2 / MSVC / rustc / cargo / rustup 全绿 |
| 2 | Windows：`pnpm tauri dev` 弹出窗口显示「砚池」，热更新生效 | ⚠️ **未实测**（直接走的 release 构建）；骨架页与 IPC 已随发布版验证 |
| 3 | Windows：出包 → 安装 → 启动 | ✅ 通过：`Inkwell_0.1.0_x64-setup.exe` (1.8MB) → 静默安装退出码 0 → 启动后进程存活、窗口标题「砚池」 |
| 4 | 数据目录自动创建 | ✅ 通过：`%APPDATA%\Inkwell\{books,covers}` 首次启动即生成 |
| 5 | Android：产出 APK，包名与架构正确 | ✅ 通过：5 个 ABI 的 APK；arm64 版 8.9MB，`aapt2` 确认包名 `com.inkwell.reader`、minSdk 26、内含 `libinkwell_lib.so` |
| 6 | Android：真机安装并打开 | ⚠️ **待你验收**：本机未连接安卓设备，无法代你验证 |
| 7 | 两端无红色报错 | ✅ 构建与运行均无错误（仅有 MSVC 链接器的常规提示） |

> **待你完成的两项**：
> 1. 把 `app-arm64-release-unsigned.apk` 装到手机，确认能打开、显示「砚池」；
> 2. （可选）跑一次 `pnpm tauri dev`，确认开发时热更新正常。

---

## 五、后续阶段任务清单

### 阶段 1：MVP 阅读器（1–2 周）

| # | 任务 | 关键点 |
| --- | --- | --- |
| 1.1 | Rust 数据层：连接池、迁移框架、books/shelves 的 CRUD command | 写 `cargo test` |
| 1.2 | 导入 EPUB：选文件 → 查重 → 拷贝 → 解析 OPF 元数据 + 封面 → 入库 | `zip` + `quick-xml` |
| 1.3 | 书库 UI：网格/列表切换、封面墙、按标题/作者/时间排序、搜索框 | 虚拟滚动（书多了要能撑住） |
| 1.4 | 阅读器接入：`<foliate-view>` 挂载、TOC 侧栏、翻页/滚动模式切换 | Adapter 层 |
| 1.5 | 进度持久化：监听 relocate → 防抖存 CFI → 打开时恢复位置 | 双端一致 |
| 1.6 | 阅读设置：字号/行距/页边距/字体/主题（浅色/深色/羊皮纸） | 即时预览 |
| 1.7 | Android 适配：返回键、安全区（刘海/手势条）、触摸翻页、屏幕常亮 | 上游有 `docs/safe-area-insets.md` 可参考思路 |
| 1.8 | 删除/批量管理书籍 | 要确认弹窗 |

**验收：Windows 与 Android 都能导入 EPUB、正常阅读、关闭再打开回到原位置。**

### 阶段 2：中文化 + 批注 + 搜索（1–2 周）

| # | 任务 |
| --- | --- |
| 2.1 | 中文排版：首行缩进 2 字符、标点挤压、中文断行规则、中西文间距 |
| 2.2 | 中文字体管理：内置 1–2 款开源中文字体（思源宋体/霞鹜文楷），支持用户导入字体 |
| 2.3 | 简繁转换（opencc-js）：全局开关 + 按书设置 |
| 2.4 | 批注：划词高亮（多色）、写笔记、书签；侧栏统一列表；点击跳转 |
| 2.5 | 批注导出：Markdown / JSON |
| 2.6 | 全文搜索：单本内搜索（foliate-js `search.js`），中文用 jieba 分词 |
| 2.7 | 界面中文化全面校对 |

### 阶段 3：词典与翻译（~1 周）

| # | 任务 |
| --- | --- |
| 3.1 | 划词浮层：选中文字 → 弹出释义卡片 |
| 3.2 | 本地词典：加载 MDict `.mdx`（js-mdict），支持多个词典 |
| 3.3 | 在线词典：维基词典 / 内置基础词库 |
| 3.4 | 翻译：句子 / 段落 / 整章；支持 AI 翻译与免费翻译接口两条路 |

### 阶段 4：AI 助手 + 阅读统计（~1 周）

| # | 任务 |
| --- | --- |
| 4.1 | AI 配置：OpenAI 兼容（自填 baseURL / apiKey / model）；Key 存 Rust 侧加密文件 |
| 4.2 | 划词解释：选中即问，回答显示在侧栏 |
| 4.3 | 章节总结：取当前章节文本 → 总结 |
| 4.4 | 全书问答：章节级切分 + 关键词召回（轻量 RAG） |
| 4.5 | 阅读统计：每日/每周时长、日历热力图、每本书进度、连续阅读天数 |

### 阶段 5（可选）：双端同步（~1 周）

| # | 任务 |
| --- | --- |
| 5.1 | 同步后端：WebDAV 客户端（坚果云/自建）或局域网 HTTP |
| 5.2 | 同步内容：阅读进度（CFI）、批注、设置 |
| 5.3 | 冲突策略：按 `updated_at` 后写胜出；冲突时保留双方并提示 |

---

## 六、风险与对策

| # | 风险 | 影响 | 对策 |
| --- | --- | --- | --- |
| 1 | **foliate-js API 不稳定**（官方明说会 break） | 升级时返工 | 固定 commit + Adapter 层隔离；升级前先跑一遍回归清单 |
| 2 | **Android 文件导入**（SAF 返回 `content://` URI，Rust 不能直接读） | 安卓端导书可能卡住 | 阶段 0 就用一个最小例子验证；必要时用 dialog 插件拿到文件流后立即拷贝进应用私有目录 |
| 3 | **Android TTS 支持薄弱**（WebView 的 `speechSynthesis` 在安卓上不可靠） | 朗读功能受限 | 阶段 3 评估原生 TTS 插件或 Edge TTS 联网方案；先不承诺 |
| 4 | **双端 WebView 差异**（WebView2 vs Android System WebView 版本碎片） | 排版表现不一致 | 每次改动双端都跑一遍；不依赖过新的 CSS 特性 |
| 5 | **工作量超预期**（自研全功能 ≈ 数月） | 中途放弃 | MVP 先行；阶段 1 结束设复盘点，可切回 Fork 方案 |
| 6 | **工具链安装需管理员权限** | 阶段 0 卡住 | 生成一键脚本，你以管理员运行；我把验证做细，减少来回 |
| 7 | **磁盘空间不足** | 装不下工具链 | 待你确认 D 盘空间 |
| 8 | **首次 Rust 编译极慢**（Tauri 全量编译 20–40 分钟） | 开发体验差 | 用 `sccache` 或保持增量编译；改 UI 时用 `pnpm dev`（纯前端） |

---

## 七、质量保证

| 项 | 做法 |
| --- | --- |
| 类型安全 | TypeScript strict，`pnpm typecheck` 必须零错误 |
| 代码规范 | Biome（格式化 + lint） |
| Rust 规范 | `cargo fmt` + `cargo clippy -- -D warnings` |
| 单元测试 | 前端 Vitest（工具函数、store 逻辑）；Rust `cargo test`（数据层、EPUB 解析） |
| 手动回归 | 维护 `docs/REGRESSION.md` 清单，改动后逐条过 |
| 提交规范 | 一个提交一件事，中文提交信息，格式 `类型: 摘要` |

---

## 八、已确认的决策（2026-09-19）

| # | 决策项 | 结论 |
| --- | --- | --- |
| 1 | 应用显示名 | **砚池**（英文 **Inkwell**） |
| 2 | Windows 产品名 / Android 包名 | 产品名 `Inkwell`；包名 `com.inkwell.reader`（跟随应用名） |
| 3 | 书库存放位置 | 默认 `{AppData}/Inkwell/books/`（跟随应用名） |
| 4 | 界面语言 | **仅中文** |
| 5 | 磁盘空间 | ✅ 已确认 D 盘空间充足 |
| 6 | 阶段节奏 | **阶段 0 完成后停下来验收**，通过后再进阶段 1 |

---

## 九、下一步（方案已确认，等待开工）

方案已于 2026-09-19 确认，按以下顺序执行：

1. **第 1 步**：生成 `personal/scripts/setup-toolchain.ps1`（一键安装脚本）并交付给你运行
2. **第 2 步**：你运行脚本期间，我并行搭建项目骨架（`pnpm create tauri-app` + 依赖 + 配置）
3. **第 3 步**：工具链就绪后，完成 Windows 端跑通与出包（**里程碑 1**）
4. **第 4 步**：配置 Android 环境，完成真机跑通与出包（**里程碑 2**）
5. **第 5 步**：停下来给你验收，然后进入阶段 1

---

## 附录 A：上游 Readest 关键情报（供决策参考）

| 项 | 值 |
| --- | --- |
| 仓库 | readest/readest，AGPL-3.0，24.4k stars |
| 体量 | 约 290 MB（含历史），8 个 git submodule |
| 版本 | app 0.12.8；Next.js 16.3.3 + React 19.2.8 + Tauri 2.11.x |
| 最近更新 | 2026-09-18（非常活跃） |
| 结构 | pnpm monorepo，主体在 `apps/readest-app/` |
| 构建要求 | Node 24 + pnpm 11.1.1 + Rust + MSVC C++ 工具链；Android 需 NDK |
| 自带文档 | `CONTRIBUTING.md`、`apps/readest-app/AGENTS.md`、`DESIGN.md` |

## 附录 B：本机环境实测结果（2026-09-19）

| 组件 | 状态 |
| --- | --- |
| Node.js | ✅ v22.20.0（上游建议 v24） |
| pnpm | ✅ 11.8.0 |
| Git | ✅ 2.45.1 |
| JDK | ✅ 21.0.8（Microsoft OpenJDK） |
| WebView2 Runtime | ✅ 153.0.4234.32 |
| Rust / Cargo | ❌ 未安装 |
| MSVC C++ 生成工具 | ❌ 未安装 |
| Android SDK / NDK / adb | ❌ 未安装 |
| 磁盘可用空间 | ❓ 待确认 |
