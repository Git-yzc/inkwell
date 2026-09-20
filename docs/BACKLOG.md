# 待办与已知问题（Backlog）

> 本文档记录**尚未完成**的工作与**已知问题**，供后续按需取用。
> 当前进度快照见下方「一、当前状态」；环境与流程约定见 [AGENTS.md](../AGENTS.md)。
>
> 最后更新：2026-09-20（修复 Android 启动连 localhost:1420；完成阶段 2.1 中文排版）

---

## 一、当前状态

**阶段 0（环境与骨架）✅ 完成** · **阶段 1（MVP 阅读器）✅ 完成并验收通过**
**阶段 2 进行中**：中文排版 ✅（§3.1）；中文字体 / 简繁转换 / 批注 / 全文搜索待做

已经能用的：

| 能力 | 说明 |
| --- | --- |
| 书库 | 导入（9 种格式）、封面网格、搜索、四种排序、删除 |
| 阅读 | foliate-js 渲染、目录跳转、翻页/滚动、滚轮与左右点按与方向键翻页 |
| 进度 | EPUB CFI 精确记录，重新打开回到原位置 |
| 设置 | 字号 / 行距 / 页边距 / 字体 / 主题（浅色·羊皮纸·深色）/ 分栏 / 中文排版 |
| 中文排版 | 首行缩进 2 字、行首禁则、中西文自动间距（自动 / 开 / 关） |
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
| 修复后 `apk/arm64/release/app-arm64-release.apk` | `index-zQoNuFaf.js` | 前端资源已内嵌 |

> ⚠️ **判据只能是 `index-*.js`，不能拿 `localhost:1420` 当判据**。
> devUrl 是配置数据，修复前后都会被编进二进制，用它会得出完全相反的结论。

这条校验已经固化进 `personal/scripts/build-android.ps1`：出包后自动从每个 APK 里
解出 `.so` 搜 `index-*.js`，搜不到直接 `exit 1`——和签名校验一样是硬性的，
不会再悄悄放行开发模式产物。

**验收标准**：APK 装上后直接打开书库，不需要任何本地服务在跑。
（需你在真机上确认：本机没有安卓设备，只能验证到「资源确实内嵌」这一层。）

---

### 2.3 其他尚未实测的项

| 项 | 说明 |
| --- | --- |
| Android 真机 | 0.1.0 签名包**能装**；启动报错已修（§2.2），**待你在真机上验收** |
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

**验收**：真机导入待复验。可离线验证的部分已固化成单测 ——
`extracts_file_name_from_saf_uri`、`tolerates_document_id_uri`、
`percent_decode_handles_utf8_and_bad_escapes`、`sniffs_format_from_magic_bytes`，
其中那条 URI 的形状就是照真机报错复原的。

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

### 3.4 批注（高亮 / 笔记 / 书签）

**数据表已经建好**（`annotations`，见 `src-tauri/src/db.rs` 的迁移 v1），
但目前没有任何代码使用它。

要做：
- 划词高亮（多色）、写笔记、书签
- 侧栏统一列表，点击跳转
- 导出为 Markdown / JSON

**技术要点**：foliate-js 用 `view.addAnnotation()` / `deleteAnnotation()`，
注解对象形如 `{ value: cfi }`；划词选区通过 `renderer.getContents()` 拿。
具体见 `overlayer.js` 与 `view.js` 的 `#createOverlayer`。

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
| PDF 支持被桩掉 | 因 foliate-js 的 `pdf.js` 有一行不合规的 `new URL()` 导致构建失败，已用 Vite 插件替换成桩。真正接入还需把 `pdf.worker.mjs`、`cmaps`、`standard_fonts` 作为静态资源发布 | `vite.config.ts` · `src/features/reader/engine/pdf-stub.js` |
| 非 EPUB 元数据 | 目前只有 EPUB 会解析元数据与封面，mobi/azw3/fb2/cbz/txt/md 一律用文件名兜底 | `src-tauri/src/epub.rs` |
| `book_shelves` 表未使用 | 书架/分类功能只建了表 | `src-tauri/src/db.rs` |
| `library::rename_book` 未接 UI | 后端有 `rename_book` command，前端没有入口（元数据识别错时改不了名） | `src/routes/Library.tsx` |
| 封面占位色 | 无封面时按书名哈希取色，算法很粗糙，够用但不精致 | `src/components/BookCard.tsx` |

---

## 八、接手时的建议顺序

1. ~~修滚轮~~ ✅（§2.1）
2. ~~修 Android 启动连 devUrl~~ ✅（§2.2）——**待你在真机验收**
3. ~~中文排版~~ ✅（§3.1）
4. **下一步建议**：阶段 2 剩下的 —— 中文字体管理（§3.2）、简繁转换（§3.3）、
   批注（§3.4，`annotations` 表已建好）、全文搜索（§3.5）
5. 然后按阶段 3 → 4 推进，每完成一块就出包给用户验收

> 每次改动界面后，**务必用 AGENTS.md §5.4 的 CDP 方法驱动真实应用验证一遍**。
> 阶段 1 有三个「构建全绿、功能全废」的 bug 就是这样抓出来的；
> 本轮中文排版也是靠它才看出「书内 `body > p { text-indent: 1em }` 会盖掉我们的 2em」。
