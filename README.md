# 砚池 · Inkwell

个人自用的跨平台电子书阅读器，**Windows + Android 双端**，纯本地、不联网回传。

| 项 | 值 |
| --- | --- |
| 中文显示名 | **砚池** |
| 英文 / 产品名 | **Inkwell** |
| 应用标识 | `com.inkwell.reader` |
| 数据目录 | `%APPDATA%\Inkwell\` |

## 技术路线

**自研精简外壳 + 复用成熟渲染内核。**

| 层 | 选型 |
| --- | --- |
| 应用框架 | Tauri v2（Rust + 系统 WebView，安装包约 10–15 MB） |
| 前端 | Vite 7 + React 19 + TypeScript + Tailwind 4 |
| 状态 | Zustand |
| 数据 | SQLite（Rust 侧 rusqlite，含 FTS5 全文索引） |
| **渲染内核** | **foliate-js（MIT）** —— 支持 EPUB / MOBI / AZW3 / FB2 / CBZ / PDF |

---

## 下载安装

安装包见 [Releases](https://github.com/Git-yzc/inkwell/releases)。

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows x64 | `Inkwell-0.1.0-win-x64-setup.exe` | NSIS 安装包，双击安装 |
| Android arm64 | `Inkwell-0.1.0-arm64.apk` | 绝大多数现代手机选这个 |
| Android 通用 | `Inkwell-0.1.0-universal.apk` | 含全部架构，体积大，兼容性最好 |

> Android 包已用自签名证书签名，可直接安装。首次安装时系统会提示「未知来源」，允许即可。

---

## 当前状态

**阶段 0 与阶段 1 已完成，双端可构建、可日常阅读。**

| 已经能用 | 说明 |
| --- | --- |
| 书库 | 导入（epub/mobi/azw3/fb2/cbz/pdf/txt/md）、封面网格、搜索、排序、删除 |
| 阅读 | foliate-js 渲染、目录跳转、翻页 / 滚动两种模式、滚轮与点按与方向键翻页 |
| 进度 | EPUB CFI 精确记录，重新打开回到原位置 |
| 设置 | 字号 / 行距 / 页边距 / 字体 / 主题（浅色·羊皮纸·深色）/ 分栏 |

**已知问题**：Android 版启动时报 `localhost:1420` 连接失败 —— 根因与修复方案见 `docs/BACKLOG.md` §2.2。

| 文档 | 内容 |
| --- | --- |
| **`docs/BACKLOG.md`** | ★ **待办与已知问题（继续开发前必看）** |
| `docs/IMPLEMENTATION_PLAN.md` | 实现规划与开发方案 |
| `AGENTS.md` | 开发约定 / 项目铁律 / 环境现状 / 踩坑记录 |
| `personal/README.md` | 私有定制层说明 |

---

## 许可与来源

| 项 | 说明 |
| --- | --- |
| 本项目代码 | **MIT**，见 `LICENSE` |
| 渲染内核 | [foliate-js](https://github.com/johnfactotum/foliate-js)（**MIT**，以 git submodule 固定 commit 引入） |
| 第三方声明 | 见 `THIRD-PARTY-NOTICES.md` |

---

## 构建

环境已就绪，直接出包：

```powershell
# Windows 安装包
powershell -ExecutionPolicy Bypass -File .\personal\scripts\build-win.ps1

# Android APK
powershell -ExecutionPolicy Bypass -File .\personal\scripts\build-android.ps1
```

产物在 `personal/out/` 也有副本。全新机器上的环境准备见 `AGENTS.md` §5.3。
