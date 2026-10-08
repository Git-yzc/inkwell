# 待办与已知问题（Backlog）

> 本文档记录**尚未完成**的工作与**已知问题**，供后续按需取用。
> 当前进度快照见下方「一、当前状态」；环境与流程约定见 [AGENTS.md](../AGENTS.md)。
>
> 最后更新：2026-10-08（**0.2.1 已修复**：夜间 / 深色阅读主题下正文里的作者字色不跟随主题，
> 深字压深底看不清 —— 见 §2.7；0.2.0 的 App 白天 / 夜间、移动端工具栏交互、页号角标、
> 页边距修复、PDF 导入与阅读见 §2.6）
>
> 📌 **0.2.0 需求**见 [`docs/REQUIREMENTS-2026-10-05.md`](REQUIREMENTS-2026-10-05.md)
> （8 条需求 / 17 条决策）。实现记录与新增的已知问题见本文 **§2.6**，
> 逐条实现说明与实测结果见需求文档 **§八**。

---

## 一、当前状态

**阶段 0（环境与骨架）✅ 完成** · **阶段 1（MVP 阅读器）✅ 完成并验收通过**
**阶段 2 进行中**：中文排版 ✅（§3.1）、批注 ✅（§3.4）、**0.2.0 增强批次 ✅ 已实现**（§2.6）；
中文字体 / 简繁转换 / 全文搜索待做

已经能用的：

| 能力 | 说明 |
| --- | --- |
| 书库 | 导入（9 种格式，含 PDF）、封面网格、搜索、四种排序、删除 |
| 阅读 | foliate-js 渲染、目录跳转、翻页/滚动、滚轮与左右点按与方向键翻页 |
| **PDF** | 渲染 / 翻页 / 目录跳转 / 进度记忆；首次打开渲染首页做封面、回写标题与作者（§2.6） |
| 进度 | EPUB CFI 精确记录；PDF 用进度比例落回页码，重新打开回到上次那一页 |
| 设置 | 字号 / 行距（默认 1.5）/ 页边距 / 字体 / 主题（浅色·羊皮纸·深色）/ 分栏 / 中文排版 |
| **App 主题** | 白天 / 夜间 / 跟随系统（默认白天），书库与各面板整体跟它走（§2.6） |
| **正文有色字** | 作者点名的字色按当前阅读主题自动调到可读（保色相只调明暗，§2.7） |
| 中文排版 | 首行缩进 2 字、行首禁则、中西文自动间距（自动 / 开 / 关） |
| 批注 | 划词高亮（四色）、笔记、书签、侧栏列表与跳转、导出 Markdown / JSON |
| 平台 | Windows（NSIS 安装包）、Android（APK）双端均可构建 |

**用户验收结论**：基本可用。已修复「翻页模式下鼠标滚轮无效」（§2.1）
与「Android 启动连 localhost:1420」（§2.2）。

---

## 二、问题与修复记录

### 2.1 ✅ 已修复：翻页模式下鼠标滚轮不翻页

**原现象**：选「翻页」模式时鼠标滚轮无反应，只能点按左右区域或按方向键翻页；「滚动」模式正常。

**根因**：foliate-js 的 `paginator.js` 里**完全没有 wheel 事件处理**（全局搜索 `wheel` 零命中）。
`paginated` 模式容器是 `overflow: hidden`，靠 CSS 分栏 + 平移定位，滚轮事件无人接管就被丢掉；
`scrolled` 是原生滚动所以正常。此外滚轮事件产生在书籍 iframe **内部**，不会冒泡到外层文档。

**修复**（只改 `src/features/reader/engine/index.ts`，未动 submodule）：

在 `load` 事件交出的 `doc` 上挂 `wheel` 监听（`{ passive: false }`），仅 `flow === 'paginated'` 时拦截；
累积 `deltaY` 超过 50 翻一页，触发后 250ms 冷却；`deltaMode` 为「行 / 页」时先折算成像素；
`close()` 里摘掉监听。

> 查证补充：内核切换 `flow` 只走 `Paginator.render()`（paginator.js:754），**只重排、不重建文档**；
> 只有换章节才会重建（`#createView()` 仅被 `#display` 调用）。所以监听挂一次即可，
> 换章节时用 `#wheelDoc` 去重，避免重复绑定。

**验收**（CDP 驱动真实应用，用 `Input.dispatchMouseEvent` 派发**真实**滚轮事件）：

| 用例 | 期望 | 实测 |
| --- | --- | --- |
| 单次向前 | +1 页 | ✅ +1 |
| 单次向后 | −1 页 | ✅ −1 |
| 8 次同发（10ms 内） | +1 页 | ✅ +1 |
| 连拨 5 次（逐个派发） | +1 页 | ✅ +1 |
| 连拨 5 次 × 14 轮冷启动压测 | 每轮 +1 页 | ✅ 14/14 |
| 两次 20px 微小滚动（不足阈值） | 0 页 | ✅ 0 |
| 切到滚动模式后滚轮 | 原生滚动照常 | ✅ fraction 增大 |

> 遗留观察：累计 23 次尝试中有 1 次快速连拨翻了 2 页（疑似首次翻页阻塞主线程、
> 事件延迟送达越过了 250ms 冷却）。此后 14 轮冷启动压测未复现，按「不引入不必要复杂度」
> 暂不加码；若日后重现，可改用 `e.timeStamp`（事件产生时刻）而非 `Date.now()` 计时冷却。

### 2.2 ✅ 已修复：Android 装上后启动即报 `Failed to request http://localhost:1420/`

**现象**：签名后的 APK 已经能正常安装了，但一启动就只显示：

```
Failed to request http://localhost:1420/: error sending request for url (http://localhost:1420/)
```

**影响范围**：**只有 Android 有**，Windows 正常。

**根因（已实证，不是猜测）**：Android 的 .so 是在**开发模式**下编译的 ——
二进制里烧进了 devUrl，却没有内嵌前端资源。

证据链：

| 检查项 | Windows `inkwell.exe` | Android `libinkwell_lib.so` |
| --- | --- | --- |
| 二进制含 `localhost:1420` | 有 | **有**（devUrl 被烧了进去） |
| 二进制含 `index-Bhf8T1nl.js` | **有** | **无** |
| 二进制含 `index-ClehkLd5.css` | **有** | **无** |
| Cargo build script 输出 | `cargo:dev=false` | `cargo:dev=true` |

机制（读依赖源码得到，非推测）：

- `tauri` 的 build.rs（`tauri-2.11.5/build.rs:255`）：
  `let custom_protocol = has_feature("custom-protocol"); let dev = !custom_protocol;`
- `tauri-build` 的 `is_dev()`（`tauri-build-2.6.3/src/lib.rs:425`）读 `DEP_TAURI_DEV`，
  再由同文件 :519 的 `cfg_alias("dev", is_dev())` 决定走「内嵌资源」还是「连 devUrl」。
- 本仓库 `src-tauri/Cargo.toml` **没有 `[features]` 段**，没有任何地方开启 `tauri/custom-protocol`。
- Windows 走官方 CLI（`pnpm tauri build`）→ `dev=false`；
  Android 走我们自建的 `src-tauri/tauri.js` shim（只调 `cargo build --release`，
  不带官方 CLI 会加的特性）→ `dev=true`。
  佐证：`target/aarch64-linux-android/release/build/` 下同时存在
  `cargo:dev=true` 与 `cargo:dev=false` 两个 tauri 构建目录。

**实际修复（2026-09-20）**：按候选方案 1 + 2 落地，共改两处。

1. `src-tauri/Cargo.toml` 补上官方模板的 features 段：
   ```toml
   [features]
   custom-protocol = ["tauri/custom-protocol"]
   ```
2. `src-tauri/tauri.js` 在 `--release` 时追加 `--features custom-protocol`。
   debug 不加：`pnpm tauri android dev --host` 走的正是这个 shim 的 debug 分支，
   那条路要连宿主机的 devUrl（官方 CLI 会把它改写成局域网 IP），内嵌资源反而会坏事。

**复核结果**（从 APK 内解出 `lib/arm64-v8a/libinkwell_lib.so` 再搜字符串）：

| 产物 | 内含 `index-*.js` | 结论 |
| --- | --- | --- |
| 修复前（0.1.0 首次发布的那份 arm64 包） | **无** | 开发模式产物，启动即连 localhost:1420 |
| 修复后 `apk/arm64/release/app-arm64-release.apk` | 有（形如 `index-*.js`） | 前端资源已内嵌 |

> ⚠️ **判据只能是 `index-*.js`，不能拿 `localhost:1420` 当判据**。
> devUrl 是配置数据，修复前后都会被编进二进制，用它会得出完全相反的结论。

这条校验已经固化进 `personal/scripts/build-android.ps1`：出包后自动从每个 APK 里
解出 `.so` 搜 `index-*.js`，搜不到直接 `exit 1`——和签名校验一样是硬性的，
不会再悄悄放行开发模式产物。

**验收标准**：APK 装上后直接打开书库，不需要任何本地服务在跑。
✅ **真机已确认**（2026-09-20，Redmi K90）：装上直接进书库，不再报错。

---

### 2.3 其他尚未实测的项

| 项 | 说明 |
| --- | --- |
| Android 真机 | ✅ **已验收通过**（2026-09-20）：能装、能开、能导入、界面正常（§2.2 / §2.4 / §2.5） |
| `pnpm tauri dev` 热更新 | 一直走的 release 构建，开发模式的热更新流程未实测 |
| 大书库性能 | 目前书本数量很少。书多了之后封面网格需要虚拟滚动 |

---

### 2.4 ✅ 已修复：Android 导入 EPUB 报「文件不存在」

**现象**（用户在 Redmi K90 上实测）：本地确实有那个 epub，选中后导入失败，提示：

```
失败 1 本: %E5%BE%90%E6%98%8E%E8%8B%B1...%20illegal.epub: 文件不存在
```

**根因**：Android 的文件选择器走 SAF，交回来的是 **`content://` URI**，不是文件路径
（`tauri-plugin-dialog` 的 `DialogPlugin.kt:117` 直接把 `uri.toString()` 递给前端）。
而 `import_books` 拿它当路径用：`Path::new("content://...").exists()` → false → 「文件不存在」。
提示里那串 `%E5%BE%90...` 就是被百分号编码的文件名 —— 正好坐实了来源是 URI。

> 这条在阶段 0 的风险清单里就写过（`IMPLEMENTATION_PLAN.md` §六-2），当时没做最小验证，
> 于是拖到真机上才暴露。

**修复**（`src-tauri/src/lib.rs`）：导入前先把来源「落地」成本地文件。

- 用 `tauri-plugin-fs` 的 `Fs::open()` —— 它在 Android 上会走原生 `ContentResolver` 拿 fd，
  再用 `std::io::copy` 写到数据目录的临时文件。之后整条链路（算指纹、解析元数据、
  拷进书库）照旧按本地路径走，一行都不用改。
- 文件名从 URI 末段还原（含百分号解码）：`primary%3ADownload%2F书.epub` → `书.epub`。
- 有些 provider 的末段只是文档 id（`msf%3A1000000043`），看不出扩展名。这时从**文件头**
  猜格式（`%PDF` / `BOOKMOBI` / `PK`；zip 容器用现成的 EPUB 解析器区分 EPUB 与 CBZ），
  否则会在格式判断那一步被拒。
- 临时目录用完即删，每批导入前先清一次残留。

**验收**：✅ **真机已确认**（2026-09-20）—— 之前失败的那本书现在能正常导入。
可离线验证的部分另固化成单测 ——
`extracts_file_name_from_saf_uri`、`tolerates_document_id_uri`、
`percent_decode_handles_utf8_and_bad_escapes`、`sniffs_format_from_magic_bytes`，
其中那条 URI 的形状就是照真机报错复原的。

### 2.5 ✅ 已修复：Android 界面顶到状态栏；双指缩放把整页缩到左上角

**现象**（同一台机器）：

1. 书库的标题与搜索框直接压在最顶上，与状态栏重叠；
2. 双指一捏，整页缩到屏幕左上角、四周留一大片空白（用户截图就是这个样子）。

**根因（两个独立问题）**：

1. **状态栏重叠**：Tauri 模板在 `MainActivity.onCreate` 里调了 `enableEdgeToEdge()`，
   但**没有任何地方消费 insets**。`enableEdgeToEdge()` 只是「允许」edge-to-edge，
   系统栏盖在内容上这件事得自己让位；Android 15 起（targetSdk 35+）更是强制 edge-to-edge。
   > ⚠️ **别指望 CSS 的 `env(safe-area-inset-*)`**：Android WebView 只按「屏幕挖孔」上报，
   > 不会把状态栏高度算进去，靠它顶不住。
2. **缩放**：WebView 自带的 pinch-zoom 没关。App 外壳不需要它 —— 正文大小由阅读设置里的
   字号控制，捏合缩放还会打乱 foliate 的分页。

**修复**（`src-tauri/gen/android/app/src/main/java/com/inkwell/reader/MainActivity.kt`）：

- 把 `ViewCompat.setOnApplyWindowInsetsListener` 挂在 `android.R.id.content` 上，
  按 `systemBars() or displayCutout()` 的实际高度给根布局补 padding；
- `onWebViewCreate` 里关掉 `setSupportZoom` / `builtInZoomControls` / `displayZoomControls`；
- 状态栏图标改浅色（`SystemBarStyle.dark`），并把 `windowBackground` 设成 `#FF0A0A0A` ——
  edge-to-edge 下系统栏区域画的是窗口底色，不设会露出一条白边。

**验收**：用 `apkanalyzer dex code` 反汇编 APK 里的 `MainActivity`，确认改动确实进包了 ——
`findViewById(0x1020002)`（即 `android.R.id.content`）+ `ViewCompat.setOnApplyWindowInsetsListener`，
以及 `setSupportZoom(false)` / `setBuiltInZoomControls(false)` / `setDisplayZoomControls(false)` 都在。
✅ **真机已确认**（2026-09-20）：顶栏不再压状态栏，双指缩放也不再缩小整页。

---

### 2.6 ✅ 已实现：0.2.0 增强批次（App 主题 / 移动端交互 / 页号角标 / 页边距 / PDF）

需求原文与 17 条决策见 [`docs/REQUIREMENTS-2026-10-05.md`](REQUIREMENTS-2026-10-05.md)，
逐条验收见该文档 §八。本节只记**实现过程中真正值得记住的东西**。

### ① 页边距「非 0 就塌陷」—— 传下去的值缺了单位（REQ-2026-10-05-06）

`engine/index.ts` 原来写的是 `renderer.setAttribute('margin', String(s.margin))`，
传下去的是裸数字 `40`。内核把它**原样**塞进 CSS 变量 `--_margin`
（paginator.js 的 `attributeChangedCallback`），而该变量被当作长度用在
`grid-template-rows: minmax(var(--_margin), 1fr)` 与 `height: var(--_margin)`。

- `margin = 0` → `minmax(0, 1fr)`：裸 0 在 CSS 里**是**合法长度，布局正常；
- `margin = 40` → `minmax(40, 1fr)`：裸数字不是合法长度，**整条声明失效**，
  网格行塌掉 —— 正文被压成内容高度的一小块。

修法是一行：传 `\`\${s.margin}px\``。内核的 `#beforeRender` 用 `parseFloat` 取值，
带 `px` 照样得到 40，后续计算全不受影响。
**教训**：只要是喂给 CSS 的数值，跨越内核边界时就必须补单位。

### ② 面板「深底黑字」与 App 主题配色（REQ-2026-10-05-07 / -08）

根因是配色**靠继承**：面板硬编码暗色背景，却没有声明自己的前景色，
于是继承了根节点注入的**阅读主题**字色；默认阅读主题是浅色 → 深底配深字。
`<select>` 最明显，因为 `<option>` 弹层由系统绘制、取的正是 `select` 的 `color`。

现在把 App 外壳配色收敛成一组 CSS 变量（`src/styles/globals.css` 的
`--app-bg / --app-surface / --app-surface-strong / --app-fg / --app-muted /
--app-border / --app-hover / --app-accent`），用 `@theme inline` 暴露成
Tailwind 的 `bg-app-surface` / `text-app-fg` 这类工具类，组件一律只用这些类。

> ⚠️ **刻意不用 Tailwind 的 `dark:` 变体**：它默认跟随**系统**深浅，
> 而我们要跟随 App 自己的设置（选了「跟随系统」时才由 JS 解析系统值）。
> 所以根节点上的 `data-app-theme` 永远是解析后的 `light` / `dark`，
> 由 `src/store/app-theme.ts` 维护。改面板配色时**别再引入 `dark:`**，
> 否则会出现「白天模式里某块还是黑的」这种半吊子状态。
>
> 阅读主题（浅色 / 羊皮纸 / 深色）与 App 主题是两个维度：前者只管**正文页面**，
> 后者管书库、各面板、阅读页顶栏与底栏。按 Q17，阅读页顶底栏跟 **App 主题**。

### ③ PDF 接入（REQ-2026-10-05-04）

之前 PDF 是被**我们自己的构建配置**桩死的（`vite.config.ts` 把
`foliate-js/pdf.js` 换成一个抛错的桩），原因写在桩文件里：
上游第 1 行 `new URL(\`vendor/pdfjs/\${path}\`, import.meta.url)` 缺 `./` 前缀，
Vite 会把它当非法 glob 并让**整个前端构建失败**。

现在改用 `foliatePdf()` 插件在**转换阶段**改两处（submodule 保持原样，两处都做了匹配断言，
上游结构一变就构建报错）：

1. URL 基准换成 `document.baseURI` + 根相对路径 `/pdfjs/…`；
2. 给 PDF 的 rendition 补 `spread: 'none'`。**不补的话内核会把相邻两页拼成跨页** ——
   桌面宽屏下变成「左右各一页」，页码与进度跳着走（1、3、5…）。

资源（`pdf.worker.mjs` / `cmaps` / `standard_fonts` / 两个层样式，共 191 个文件）
由插件在 `closeBundle` 时拷进 `dist/pdfjs/`，dev 下由中间件直接指向 submodule 目录。
**产物只发布 `dist/`**，这一拷贝不能少，而且必须**从装好的产物里验证**，
光看 `vite build` 成功说明不了问题。

其余取舍：

- **进度**：PDF 没有可用的 CFI（内核的 `resolveCFI` 未实现），位置只记进度比例，
  `goToFraction()` 落回页码（一页一节、每节 size 相同，比例即页码）。数据库结构没动。
- **位置指示**：固定版式（PDF / 漫画）一页就是一节，角标显示**页码**而不是 Kindle 位置。
- **封面 / 元数据**：首次打开（`coverPath` 还是 null）时，前端把第 1 页渲成图、缩到 480px
  编码成 JPEG，连同 PDF 元数据里的标题 / 作者一起回写书库（新增 `save_book_cover` command，
  标题 / 作者复用已有的 `rename_book`）。走 JSON 数组传字节不精致，但一次性、只有几十 KB。
- **批注**：PDF 本次不做，顶栏书签按钮直接不出现，划词与下拉手势也不绑 ——
  免得弹出「能点但存不下」的操作栏。

### ④ 双击正文中间区域呼出工具栏 + 误触修复（REQ-2026-10-05-01 / -03）

**误触的根因**：工具栏显隐原来不区分触发位置（`window` 上任何 `pointerdown` 都
`setBarVisible(true)`），而 React 对 `pointerdown` 这类离散事件是**同步刷新**的 ——
同一次手势里紧随其后的 `mousedown` / `click` 就会落到**刚显示出来**的进度条上，
`input[type=range]` 在轨道上按下即按坐标设值 → `goToFraction()` 真的跳走阅读位置。

按 Q8 采用方案 B：工具栏隐藏时在顶栏 / 底栏之上盖一层**屏蔽层**（`z-[25]`，
压得住工具栏 `z-20`、低于侧栏面板 `z-30`），首次按下由它 `preventDefault()` +
`stopPropagation()` 整只吞掉、只负责把工具栏叫出来。

**⚠️ 这里有个必须踩一次的坑：屏蔽层不能在 `pointerup` 就撤掉。**
`click` 是在 `pointerup` **之后**才派的；那时工具栏已经显示、真实控件也恢复了
`pointer-events`，click 就会落到按钮上。CDP 实测抓到的正是这个：
隐藏态点顶栏「设置」所在的位置 → 工具栏出来了，**设置面板也被一起点开**
（而进度条没事，因为 `input[type=range]` 是靠 pointerdown/mousedown 改值的）。
所以屏蔽层要一直留到把 `click` 也吞掉为止，拖拽这类不产生 click 的手势用 400ms 定时器兜底。

**双击判定自己实现**（不用 `dblclick`）：Android WebView 在关掉缩放后并不保证派发它。
监听挂在**书籍文档**上 —— 左右 18% 的翻页点按区是外层文档里的透明按钮、盖在 iframe 之上，
点按根本到不了书籍文档，所以「只在中间区域生效」是天然成立的。
按 Q3，第一次点按时若**已经**有选区就整组不响应；否则把这次双击顺带选中的词清掉
并短暂抑制选区回调（Android 双击正文会选词，不清掉会「工具栏和批注栏一起弹」）。

> 代价要说清楚：这样等于**牺牲了「双击选词」**（长按选词仍然可用）。
> 这是为了让「双击呼出工具栏」在文字上也能用，属于有意的取舍。

**怎么在桌面上验证 Android 的触摸交互**（这次就是这么做的，值得照抄）：
CDP 用 `Input.dispatchTouchEvent` 派发真实触摸，再用
`Emulation.setUserAgentOverride` 把 UA 改成 Android，`isAndroid()` 就会放行 ——
不必为了测一条 Android-only 的交互去插桩。实测结果：

| 用例 | 结果 |
| --- | --- |
| 隐藏态双击正文中间 | 顶栏 opacity 0 → 1；再双击 1 → 0 |
| 双击时是否误翻页 | section 不变 |
| 隐藏态点底栏进度条位置 | 工具栏出现，**滑块值 211 → 211 不变** |
| 隐藏态点顶栏「设置」位置 | 工具栏出现，**面板没被打开**（修掉 click 泄漏之后） |
| 显示态点进度条 | 正常跳转（199） |
| 左右 18% 点按区 | fraction 0.1927 → 0.1867 → 0.1927，翻页照旧 |
| 已有选区时双击 | 不切换工具栏（Q3） |
| 无选区双击（会带出选词） | 工具栏切换、**批注栏不弹**、选区被清空 |
| EPUB 划词 | 批注操作栏照旧弹出（回归通过） |

### ⑤ 跟随系统深浅不实时（REQ-2026-10-05-08 的返工，2026-10-05）

**现象**（用户真机/桌面反馈）：选了「跟随系统」之后，再去改操作系统的夜间模式，
App **不会跟着变**，必须重启 App 才生效。

**根因**：原来只挂了一条通道 —— `window.matchMedia('(prefers-color-scheme: dark)')`。
在 Windows(WebView2) 上这条**不可靠**：`prefers-color-scheme` 什么时候重新求值由宿主决定，
只靠它时用户实测「切了系统的夜间模式，App 一动不动，重启才跟着变」。
（「重启才生效」正是这个特征：重启 = 重新算一次。）
Android 侧同样有隐患：清单里把 `uiMode` 放进了 `configChanges`（Activity 不重建），
WebView 是否重新求值不能想当然。

**修法**：**两条通道汇到同一个处理函数**，按 store 里的 `theme` 去重
（两边可能各报一次，重复联动会把用户手选的阅读主题来回冲掉）：

1. `matchMedia('(prefers-color-scheme: dark)')` 的 `change`；
2. Tauri 的窗口主题事件 `getCurrentWindow().onThemeChanged`
   （Windows 上由 tao 监听 `WM_SETTINGCHANGE` 后报上来，payload 是 `light` / `dark`）。

**实测（Windows，装好的 0.2.0）**：系统切浅色 → App 不重启即在 ~2 秒内变浅色，
阅读主题同步变浅色；切回深色同样跟随。

> **验证方法**（值得复用）：改 `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`
> 的 `AppsUseLightTheme`，再向所有窗口广播 `WM_SETTINGCHANGE` 且 `lParam = "ImmersiveColorSet"`，
> 这就是系统设置界面切换深浅模式时做的事。**测完记得改回去并再广播一次**。
>
> ⚠️ **Android 真机上是否实时跟随还没验过**。若真机上也发现要重启才跟随，
> 下一步就在 `MainActivity.kt` 的 `onConfigurationChanged`（uiMode）里
> 把当前深浅推给 WebView，前端再加一条 `inkwell:system-theme` 事件通道 ——
> 这条路本机没法验证，所以先按「两条事件通道」交付。

### ⑥ 双击安装包装不上（「无法打开要写入的文件」），两条原因叠加

**现象**：Windows 上双击安装包，进度条刚开始就弹
「无法打开要写入的文件: `D:\Apps\Inkwell\inkwell.exe`」，中止/重试/忽略都不管用。

**根因**（实测确认，两条）：

1. **Tauri 的 NSIS 模板会沿用上次的安装位置，且不检查它是否存在。**
   生成的 `installer.nsi` 里 `.onInit` 在 `$INSTDIR` 仍是占位符时调
   `RestorePreviousInstallLocation`，它读 `HKCU\Software\inkwell\Inkwell` 的默认值
   并**直接覆盖 `$INSTDIR`**。上次装在 `D:\Apps\Inkwell`、后来手工把目录删了，
   安装器下次还是会往那个不存在的路径写。注册表里那条值是安装成功时写下的
   （正常卸载会清掉，手工删目录就会留下这个「毒」值）。
2. **安装包放在仓库里直接双击会被沙箱拦住写入**（见 [AGENTS.md](../AGENTS.md) §3 第 3 条）：
   DSH 按「可执行文件是否位于会话工作区内」限制进程写入，工作区内的安装包
   **写不进任何工作区外的目录**。铁证：同一个安装包（SHA256 相同），
   `personal/out/` 里运行 → **exit 0 但 0 个文件**（假成功！）；
   复制到 `%TEMP%` 再运行 → 正常装好。

**修法**：新增 `personal/scripts/install-win.ps1` —— 先删掉那个注册表值、
结束在跑的 `inkwell.exe`，再把安装包复制到 `%TEMP%` 后运行；
`build-win.ps1` 出包后也会自动另存一份到 `%USERPROFILE%\Downloads\Inkwell\` 并提示
「双击这份」。手工等价操作：把安装包拷出工作区再双击（GUI 目录页也能用「浏览」改路径）。

**用户复发的第二轮（同一天）**：在原目录装、换目录装、**以及维护页里的「卸载」**
全部失败 —— 因为**三个操作都是那个工作区内的安装器发起的**：它写不了文件，
它拉起的卸载器同样被限制，于是 NSIS 报「无法卸载!」。
验证：把同一份安装包放到 `Downloads` 再跑，**装（含杀掉正在运行的 App）、卸、
再装回**三条路全部 exit 0；卸载后安装目录与卸载记录清空，而
**书库 `%APPDATA%\Inkwell` 与 4 本书完好**。
> 顺带一个发现：卸载器的「删除应用数据」勾选框删的是 `%APPDATA%\com.inkwell.reader`
> 与 `%LOCALAPPDATA%\com.inkwell.reader`（按 BUNDLEID），而我们的数据在
> `%APPDATA%\Inkwell`（按应用名，见 lib.rs 的 `data_dir()`）—— **勾了也删不掉我们的数据**。
> 目前这样更安全（不会误删书库），但要知道这个复选框对我们实际上是空的。

### ⑦ 批注操作栏打开时角标压在「笔记」按钮上（REQ-2026-10-05-02 的返工，2026-10-05）

**现象**（用户真机截图）：划词调出批注操作栏后，右下角的页号角标
（`1 / 783  0%`）正好压在操作栏的「笔记」按钮上，两行字叠在一起。

**根因**：角标是**绝对定位**（`absolute right-3 z-[15]`，相对外层容器），
而批注操作栏是**正常流**里的一个 flex 项、也贴着屏幕底部。绝对定位 + 有 `z-index`
的元素会画在正常流元素之上（哪怕它在 DOM 里更早），于是角标压到了按钮上。
底栏显示时角标「上移让位」算的是底栏高度，没算操作栏。

**修法**：批注操作栏打开时（`editor !== null`）**不渲染角标**。
这时底栏的进度条与百分比仍然可见，「读到哪儿了」并不缺信息。

> 教训：这类「贴底元素互相打架」的问题，**加 z-index 只会把谁压谁换个方向**，
> 该做的是「同一时刻只留一个」。以后再有贴底 UI（释义卡片等）记得套这条。

### ⑧ 本批新增的已知问题 / 遗留

| 项 | 说明 |
| --- | --- |
| PDF 在 **Android 真机**上未实测 | pdf.js 的 worker 在系统 WebView 上能否起来是最大风险点；Windows 侧已验证可用 |
| **跟随系统**在 Android 真机上未实测 | Windows 侧已实测实时跟随（§2.6 ⑤）；Android 侧若仍要重启才跟随，按该节的备用方案接 uiMode 推送 |
| 侧栏面板会盖住批注操作栏右侧按钮 | 在批注操作栏已打开时再点「批注 / 目录 / 设置」，`inset-y-0` 的侧栏（z-30）会盖住操作栏右端的「笔记 / 保存 / 删除」（CDP 实测 `elementFromPoint` 命中的是侧栏而不是按钮）。左侧四个色块**不受影响**，关掉侧栏即恢复，所以暂未改。要修就把侧栏从「相对根容器 `inset-y-0` + `top:48`」改成挂在正文区容器里（正文区底边正好在操作栏之上），顺带也不会再盖住底栏进度条 |
| 大 PDF 内存 | 仍是整个文件读进内存再交给 pdf.js（`loadBookFile`），几十 MB 的 PDF 需留意 |
| 双击手势只做 Android | 按 Q2，Windows 桌面端（鼠标）不响应双击切换工具栏 |
| 固定版式的阅读设置 | 字号 / 行距 / 字体 / 中文排版对 PDF 不生效（这是设计，不是 bug），但设置面板里仍可调 |
| **安装包 / APK 体积变大** | PDF 资源（`pdf.worker.mjs` + `cmaps` 169 个 + `standard_fonts` 16 个，12.4 MB 原始文件）进了产物：Windows 安装包 2.7 → 6.1 MB，Android arm64 10.5 → 14 MB。如果日后要压体积，`cmaps` 只对**中日韩 PDF** 的内嵌字体有必要，`standard_fonts` 只对没内嵌字体的 PDF 有必要 —— 都没法保证不用，所以这次全留 |

> **本次实现会话对用户数据的唯一改动**：为了验证，往真实书库里导入过两本**自造的测试 PDF**，
> 验证完已通过应用自己的 `delete_book` 删除（书籍本体与封面一并清掉），书库与封面目录已恢复原样；
> 阅读设置里的「页边距」曾被测试改成 4，也已改回默认 40。

### 2.7 ✅ 已修复：夜间模式下正文里的「有色字」不跟随阅读主题（2026-10-08）

**现象**（用户截图）：阅读主题切到**深色**（夜间）后，正文里作者标了颜色的字
—— 样章里注文的蓝 `#4f74b0`、白话的棕 `#a06a1e` —— **还是原来那个颜色**，
深字压在黑底上几乎看不清。反过来的情况同样存在：书上为深色背景准备的浅色字
（`#ecc48a` / `#9fc4f5`）落在白底上，对比度只有 1.6。

**根因**：注入书籍文档的 CSS 只能把 **`html` / `body`** 的颜色改成主题色
（`buildCss()` 里那两条 `color: … !important`）。而作者点名的颜色是
**直接声明在元素上**的（`span.note { color: #4f74b0 }`），元素自己声明的颜色
**永远压过从祖先继承来的** —— `!important` 加在 `html` 上也没用。

书上自己写的 `@media (prefers-color-scheme: dark)` 备选色**也指望不上**：
那条媒体查询看的是**系统**深浅，跟我们设置里选的阅读主题（浅色 / 羊皮纸 / 深色）
是两回事 —— 系统浅色 + 阅读深色时，书给的还是给白底用的深色字（用户截图正是这一种）。

**修法**：新增 `src/features/reader/engine/author-colors.ts`，引擎里加两处调用。

1. 扫一遍正文，只挑**颜色不是继承来的**元素（计算色 ≠ 父元素计算色，
   说明这个颜色是作者点名给的；继承来的会自动跟着父元素变）；
2. 算它与**实际背景**（祖先里第一个不透明的 `background-color`，都没有就用主题底色）的
   WCAG 对比度；**达标就不动**，不达标才调；
3. 调整方式是**色相、饱和度不变，只二分推明度**到 7:1（AAA）为止 ——
   注文的蓝还是蓝、白话的棕还是棕，作者想表达的色差保留，不会一律压成灰字；
4. 重算前先**还原**上一次写进去的内联色（原串备份在 `WeakMap` 里，文档被内核换掉即释放），
   否则换回浅色主题时会拿上一次的浅色接着算，越算越白。

调用点：`load` 事件（换章节内核会**重建文档**）与 `applySettings()`（切主题）。
固定版式（PDF / 漫画）跳过 —— 那是整页位图，没有可调的文字颜色。

**实测**（CDP 驱动真实应用 + 样章第五章；用 `Emulation.setEmulatedMedia` 把系统深浅固定为
**浅色**，即书籍那套 `prefers-color-scheme: dark` 备选色不生效 —— 正是用户截图的情形）：

| 阅读主题 | 元素 | 修复前（作者原色） | 修复后 | 对比度 |
| --- | --- | --- | --- | --- |
| 深色 | 引文 / 白话 | `rgb(160,106,30)` | `rgb(216,145,45)` | 4.01 → **7.02** |
| 深色 | 注文 | `rgb(79,116,176)` | `rgb(136,161,201)` | 3.91 → **7.01** |
| 羊皮纸 | 引文 / 白话 | `rgb(160,106,30)` | `rgb(108,71,20)` | 3.91 → **7.03** |
| 羊皮纸 | 注文 | `rgb(79,116,176)` | `rgb(54,79,121)` | 4.02 → **7.02** |
| 浅色 | 引文 / 白话 | `rgb(160,106,30)` | 不动（4.59 已达标） | 4.59 |
| 浅色 | 注文 | `rgb(79,116,176)` | 不动（4.71 已达标） | 4.71 |

系统深浅为**深色**时（书改用 `#ecc48a` / `#9fc4f5`）：浅色 / 羊皮纸主题下
对比度 1.64 / 1.80 → **7.03 / 7.02**；深色主题下 11.25 / 10.25 **原样不动**。
两条路都验过，三种主题来回切都是即时生效（点设置面板里的主题按钮，走的就是用户路径）。

另外验过：换章节（`goTo(0)` / `goTo(1)`，内核重建文档）两个文档都重新适配；
「翻页 ↔ 滚动」切换后仍有效；全量扫描开销 < 1ms（那一章 466 个元素）。

> ⚠️ 复核这类改动时别整串 `removeAttribute('style')` 去「造修复前的样子」：
> 内核自己也会往书籍文档的 `html` / `body` 上写 `width` / `column-*` 这类
> **排版内联样式**（`[style*="important"]` 会把它们一起命中），摘掉之后正文会塌成一整页，
> 截出来的「修复前」根本没法对比。按 `^color: rgb(...) !important;$` 精确匹配才对
> （第一次就是这么翻的车）。

---

## 三、阶段 2：中文排版 + 批注 + 全文搜索

### 3.1 ✅ 已完成：中文排版（2026-09-20）

`RendererSettings` 新增 `cjkTypography`（自动 / 开 / 关，默认「自动」），设置面板加了对应一行。
判定为 CJK 时，在 `buildCss()` 末尾追加三条规则（`engine/index.ts` 的 `CJK_CSS`）。

| 需求 | 实现 | WebView2 实测 |
| --- | --- | --- |
| 首行缩进 2 字符 | `p, dd { text-indent: 2em }` | ✅ 18px 字号下实测 36px |
| 中文断行 / 行首禁则 | `line-break: strict` | ✅ 生效，`CSS.supports` = true |
| 中西文自动间距 | `text-autospace: normal` | ✅ 生效（Chromium 128+ 才有） |
| 标点挤压 | `text-spacing-trim: normal` | ✅ 生效（Chromium 123+ 才有） |
| 行尾标点悬挂 | `hanging-punctuation` | ❌ **Blink 不支持，直接被忽略**（只有 Safari 认） |

**「自动」怎么判**：只看**书籍 metadata 的 `language`**，**不拿 `navigator.language` 兜底**——
界面是中文的，用界面语言兜底会把英文书也判成中文，正好把「英文书不缩进」这条毁掉。
语言缺失时按「不套用」处理，用户可在设置里手动改成「开」。

#### ⚠️ 刻意没有加 `!important`（重要，别想当然地补上）

`p { text-indent: 2em }` 与书内样式**同级**，靠「后加载」取胜（foliate 把我们的 `<style>`
追加在 `<head>` 末尾）。于是：

- 书里**没写** `text-indent` 的正文段落 → 拿到 2em（这正是要修的场景）
- 书里**写了**的（脚注 `.footnote{text-indent:0}`、居中的 `.booktitle`、
  `body > p{text-indent:1em}`）→ **尊重原设计**

一旦加 `!important`，就会把 `毛泽东传` 里**居中**的书名/作者名 `p` 也顶出 2em，
并把 `西遊記` 的 `h2 + p { text-indent: 0 }`（标题后首段不缩进）一并推翻。
纯 CSS 判断不了「计算后的对齐方式」，所以这里选择不抢书内已明确表达的排版意图。

#### 实测（CDP 驱动真实应用，逐本验证）

| 书籍 | 语言 | 注入样式含 CJK 规则 | 正文首行缩进 |
| --- | --- | --- | --- |
| 毛泽东传(共6册) | zh | 是 | 36px（书内无缩进规则，由我们补上） |
| 西遊記 | zh | 是 | 18px（书内自带 `body > p{1em}`，保留） |
| Alice's Adventures in Wonderland | en | **否** | 18px（书内自带，未受影响） |

设置面板「开 / 关 / 自动」三种取值均已实测：英文书点「开」立刻变 36px，
点「关」回到 18px，点「自动」仍是 18px（语言为 en，本就不该套用）。

**遗留**：若某本书用 class 做居中（`text-align:center`）却**没写** `text-indent`，
我们的 `p` 规则仍会给它加 2em，首行会偏。加 `!important` 的代价更大（见上），
故暂不处理——遇到具体的书再针对性加规则。

### 3.2 中文字体管理

内置 1–2 款开源中文字体（思源宋体 / 霞鹜文楷体积都不小，注意安装包体积），
支持用户导入字体文件。字体文件放数据目录，用 `@font-face` 注入。

### 3.3 简繁转换

用 `opencc-js`（纯 JS，内含词典，MIT），做全局开关 + 按书设置。
需要遍历正文文本节点做替换，注意不要破坏 CFI 定位。

### 3.4 ✅ 已完成：批注（高亮 / 笔记 / 书签）（2026-09-20）

`annotations` 表在阶段 1 就建好了，这一轮把它接上。

**做了什么**：

- 划词高亮，四色（黄 / 绿 / 蓝 / 粉）—— 点色块**一步**完成，不用先点「确定」
- 高亮可带笔记；点正文里的高亮可改色、改笔记、删除
- 书签：顶栏 ☆ 一键加/去，按当前 CFI 存
- 侧栏统一列表（色块 + 原文 + 笔记 + 章节 + 时间），点击跳转
- 导出 Markdown / JSON

**几个设计取舍**：

- **`type` 只用 `highlight` 与 `bookmark` 两种**。带笔记的高亮仍然是 highlight ——
  再拆一个 note 类型只会让 UI 到处判断「这到底是哪种」。表结构允许三种，我们只用两种。
- **`color` 存色名不存色值**：以后换主题或调色板不用迁移数据。色名清单在
  `annotation.rs` 的 `COLORS`、`api.ts` 的 `HighlightColor`、`engine/types.ts` 的
  `HIGHLIGHT_COLORS` 三处对应，**加颜色时三处一起改**。
- **导出写在 Rust 侧**：前端拿不到任意路径的 fs 权限，Android 的「另存为」给的还是
  `content://` URI，前端更写不了。Rust 侧复用导入那套 `Fs::open`（见 §2.4）。

**foliate-js 的四个坑（全部实测踩过，改这块之前先看）**：

| 坑 | 说明 |
| --- | --- |
| 内核**不画**批注 | `view.addAnnotation()` 只负责解析 CFI 与取 range，然后发 `draw-annotation` 事件把 draw 回调交回来。得自己 `detail.draw(Overlayer.highlight, { color })` |
| `create-overlay` 发得太早 | 它在 overlayer **attach 之前**发出（view.js 先 emit、后 attach），必须等一个微任务再画，否则 `getContents()` 里还没有 overlayer |
| **重开书后高亮消失** | 批注从本地库读只要几毫秒、`open()` 要几秒，`setHighlights()` 往往在 `#opened` 还是 false 时就跑完了，那次重画被守卫挡掉；而 `open()` 期间的 `create-overlay` 同样在 `#opened` 置位之前。**必须在 `open()` 结尾补一次重画**；同时**清空旧高亮要放在 `open()` 开头**（放结尾会把刚设进来的新批注一起抹掉 —— 这个错我犯了两次） |
| 高亮层不在书籍 iframe 里 | Overlayer 的 SVG 挂在**应用文档**（paginator 把它 append 到自己的容器上），所以控制它外观的 CSS 变量要写在 `globals.css`，写进注入书籍的样式里没用 |

**划词选区的坐标换算**：书籍在 iframe 里，`range.getBoundingClientRect()` 是 iframe 局部坐标，
加上 `doc.defaultView.frameElement.getBoundingClientRect()` 才是顶层视口坐标。
paginator 用 px 定位 iframe、没有 transform，直接相加即可。

**验收**（CDP 驱动真实应用，逐项实测）：

| 用例 | 结果 |
| --- | --- |
| 划词 → 浮层出现（4 色 + 原文摘录 + 笔记 + 关闭） | ✅ |
| 浮层定位（贴选区上方 12px，越界夹回容器内） | ✅ 数值逐项核对一致 |
| 点色块 → 高亮创建并入库 | ✅ 顶栏计数 +1 |
| **高亮真的画在正文上** | ✅ 用 `overlayer.hitTest()` 在选区坐标命中该 CFI（影子树读不到，这是唯一可行的验证方式） |
| 侧栏列表（色块 / 原文 / 笔记 / 章节 / 时间） | ✅ |
| 点正文里的高亮 → 编辑面板（改色 / 改笔记 / 删除） | ✅ |
| 写笔记 → 保存 → 侧栏显示 | ✅ |
| 书签 ☆ ↔ ★，侧栏统计同步 | ✅ |
| **重开这本书，批注与高亮都还在** | ✅（第一次测出「高亮不重画」，修完复测通过） |

> 顺带修了一个**安卓上点不到删除按钮**的问题：书库卡片与批注列表的删除键原来只写了
> `group-hover:flex`，触摸设备没有 hover 就永远不显示。加了 `pointer-coarse:flex`。

#### 真机反馈后的两处返工（2026-09-20）

**① 操作栏从「浮在选区旁」改成「贴底横条」**

真机上选中文字后，Android 会先弹**系统自己的**「复制 / 粘贴 / 网络搜索」浮层，
把我们浮在选区旁边的操作栏盖住了。

关键认识：那是**原生浮层**，永远贴着选区、且画在 WebView **之上** ——
这不是 z-index 能解决的，浮在选区附近的任何 UI 都会被它盖住。
改成贴着屏幕底部的横条后两边互不干扰，顺带把选区坐标换算那套逻辑整个删掉了。

> 给以后做「划词弹释义卡片」（阶段 3）的提醒：**同样的坑还会再踩一次**，
> 释义卡片要么也放底部，要么就得接受被系统菜单遮挡。

**② 新增「下拉加书签」手势**

下拉过 96px 松手 → 切换当前页书签。带实时提示（`↓ 继续下拉加书签` →
`松手加书签 ★`）与结果反馈（1.6 秒自动消失）。顶栏 ☆ 按钮保留。

几个刻意的限制：

- **只在翻页模式启用**。滚动模式下向下拖就是正常的向上滚页，抢过来很别扭
- 已核对内核源码：横排时 `snap()` 只看 `vx`（`paginator.js:805`），
  纯竖直拖动不会误翻页 —— 这条是读代码确认的，不是猜的
- 正在选词时不触发（那时用户拖的是选择手柄）
- 竖直位移必须 ≥ 水平位移的 1.6 倍，避免横向翻页滑动被误判

验收用 CDP 的 `Input.dispatchTouchEvent` 派发**真实触摸事件**（让浏览器按坐标命中，
程序化派发 DOM 事件到不了 shadow root 里的 iframe）：

| 用例 | 结果 |
| --- | --- |
| 下拉 50px | ✅ 提示「↓ 继续下拉加书签」 |
| 下拉 120px | ✅ 提示「松手加书签 ★」 |
| 松手 | ✅ 书签 ☆→★，提示「已加书签 ★」，1.8 秒后自动消失 |
| 再拉一次 | ✅ ★→☆，提示「已去掉书签」 |
| 横向滑动 | ✅ 无提示、不触发 |
| 小幅下拉 70px（未过线） | ✅ 不触发 |
| 整个过程中的章节号 | ✅ 始终没变 —— 确认没误翻页 |
| 操作栏位置 | ✅ top=635 / 视口高 760，贴着底部；旧浮层已彻底移除 |

### 3.5 全文搜索

**分两步**：
1. 单本内搜索：foliate-js 自带 `view.search()`（返回 CFI 与摘录），接上 UI 即可
2. 跨书搜索：建 FTS5 虚拟表（迁移里已预留位置），中文需要 jieba 分词
   （`jieba-wasm`），否则按字切分效果很差

---

## 四、阶段 3：词典与翻译

- 划词浮层：选中文字弹出释义卡片
- 本地词典：MDict（`.mdx`）解析，可考虑 `js-mdict`
- 在线词典：维基词典等
- 翻译：句子 / 段落 / 整章；支持 AI 翻译与免费接口两条路

**注意**：引入新依赖前先确认许可证（项目铁律：不引入非 MIT/Apache 的强制依赖）。

---

## 五、阶段 4：AI 助手 + 阅读统计

- AI 配置：OpenAI 兼容（自填 baseURL / apiKey / model）
  ⚠️ **API Key 必须存 Rust 侧**，请求由 Rust 发起（AGENTS.md 铁律 5），
  绝不能放进前端或 localStorage
- 划词解释、章节总结、全书问答（章节切分 + 关键词召回）
- 阅读统计：`reading_sessions` 表已建好但未使用；
  要做每日/每周时长、日历热力图、连续阅读天数

---

## 六、阶段 5：双端同步（可选）

WebDAV 或局域网 HTTP，同步阅读进度（CFI）、批注、设置。
冲突策略：按 `updated_at` 后写胜出，冲突时保留双方并提示。

---

## 七、阶段 1 遗留的技术债

| 项 | 说明 | 影响文件 |
| --- | --- | --- |
| ~~PDF 支持被桩掉~~ | ✅ 已解决（§2.6 ③）：改为 Vite 转换插件 + 把 pdf.js 资源拷进 `dist/pdfjs/`，桩文件已删除 | `vite.config.ts` |
| 非 EPUB/PDF 元数据 | EPUB 在 Rust 侧解析，PDF 由前端看内核元数据回写；mobi/azw3/fb2/cbz/txt/md 仍用文件名兜底 | `src-tauri/src/epub.rs` |
| `book_shelves` 表未使用 | 书架/分类功能只建了表 | `src-tauri/src/db.rs` |
| `library::rename_book` 未接 UI | 后端有 `rename_book` command，前端没有入口（元数据识别错时改不了名） | `src/routes/Library.tsx` |
| 封面占位色 | 无封面时按书名哈希取色，算法很粗糙，够用但不精致 | `src/components/BookCard.tsx` |

---

## 八、接手时的建议顺序

1. ~~修滚轮~~ ✅（§2.1）
2. ~~修 Android 启动连 devUrl~~ ✅（§2.2）
3. ~~中文排版~~ ✅（§3.1）
4. ~~Android 真机反馈：导入失败、状态栏重叠、缩放~~ ✅（§2.4 / §2.5）
   —— ✅ 2026-09-20 真机验收通过，安卓端至此才算真的能用
5. ~~批注（高亮 / 笔记 / 书签 / 侧栏 / 导出）~~ ✅（§3.4）
6. ~~0.2.0 增强批次（App 主题 / 移动端交互 / 页号角标 / 页边距 / PDF）~~ ✅（§2.6）
7. **下一步建议**：阶段 2 剩下的 —— 中文字体管理（§3.2）、简繁转换（§3.3）、
   全文搜索（§3.5）。⚠️ 这三项都要先跟用户确认：字体要定体积取舍，
   简繁与跨书搜索要引入新依赖（opencc-js / jieba-wasm）
8. 然后按阶段 3 → 4 推进，每完成一块就出包给用户验收

> 每次改动界面后，**务必用 AGENTS.md §5.4 的 CDP 方法驱动真实应用验证一遍**。
> 阶段 1 有三个「构建全绿、功能全废」的 bug 就是这样抓出来的；
> 本轮中文排版也是靠它才看出「书内 `body > p { text-indent: 1em }` 会盖掉我们的 2em」。
