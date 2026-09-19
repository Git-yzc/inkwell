# 待办与已知问题（Backlog）

> 本文档记录**尚未完成**的工作与**已知问题**，供后续按需取用。
> 当前进度快照见下方「一、当前状态」；环境与流程约定见 [AGENTS.md](../AGENTS.md)。
>
> 最后更新：2026-09-19（阶段 1 完成、用户验收通过后暂停）

---

## 一、当前状态

**阶段 0（环境与骨架）✅ 完成** · **阶段 1（MVP 阅读器）✅ 完成并验收通过**

已经能用的：

| 能力 | 说明 |
| --- | --- |
| 书库 | 导入（9 种格式）、封面网格、搜索、四种排序、删除 |
| 阅读 | foliate-js 渲染、目录跳转、翻页/滚动、左右点按与方向键翻页 |
| 进度 | EPUB CFI 精确记录，重新打开回到原位置 |
| 设置 | 字号 / 行距 / 页边距 / 字体 / 主题（浅色·羊皮纸·深色）/ 分栏 |
| 平台 | Windows（NSIS 安装包）、Android（APK）双端均可构建 |

**用户验收结论**：基本可用。唯一反馈的问题是**翻页模式下鼠标滚轮无效**（见下）。

---

## 二、已知问题

### 2.1 【最优先】翻页模式下鼠标滚轮不翻页

**现象**：阅读设置里选「翻页」模式时，鼠标滚轮没有任何反应，只能点击左右区域或按方向键翻页。
切到「滚动」模式则滚轮正常。

**根因**（已查证，不是猜测）：

foliate-js 的 `paginator.js` 里**完全没有 wheel 事件处理**——全局搜索
`wheel` 零命中。它的两种模式实现方式不同：

| 模式 | 实现 | 滚轮 |
| --- | --- | --- |
| `paginated` | `#container { overflow: hidden }`，靠 CSS 分栏 + 平移定位，用 `prev()`/`next()` 翻页 | ❌ 无人处理，滚轮被丢弃 |
| `scrolled` | `:host([flow="scrolled"]) #container { overflow: auto }`（paginator.js:511） | ✅ 原生滚动，本就能用 |

另外要注意：**滚轮事件产生在书籍内容所在的 iframe 里，不会冒泡到外层文档**，
所以监听必须挂到 iframe 内部的 document 上。好消息是 foliate-js 已经在
`load` 事件里把该 document 交出来了（它自己就是这么挂 `touchstart` 的，
见 paginator.js:571-574），我们照做即可。

**建议方案**（改 `src/features/reader/engine/index.ts` 一个文件）：

1. 在已有的 `load` 事件回调中（现在是重新套用样式）额外拿到 `detail.doc`，
   给它挂一个 `wheel` 监听。
2. 监听必须用 `{ passive: false }`，否则无法 `preventDefault`，
   页面会出现回弹。
3. **不能一有滚动就翻页**：需要「累积阈值 + 冷却时间」。
   一次快速拨动会连续触发几十个 wheel 事件，直接翻页会一蹦好几页。
   建议累积 `deltaY` 超过约 50 再触发一次，触发后加约 250ms 冷却。
4. 只在 `flow === 'paginated'` 时拦截；滚动模式直接 return，交给原生滚动。
5. 章节切换时内核会重建文档，`load` 会再次触发，注意别重复绑定
   （可以在卸载时移除，或用一个标记位）。

**验收标准**：翻页模式下滚轮向前/向后各拨一次，恰好翻一页；快速连拨不会连翻多页；
滚动模式下滚轮行为不变。

**影响文件**：`src/features/reader/engine/index.ts`（适配层内解决，
不要动 foliate-js 的 submodule）

---

### 2.2 其他尚未实测的项

| 项 | 说明 |
| --- | --- |
| Android 真机 | 已出包，但**未在真机上验证过**（本机无安卓设备）。下次务必实测一遍 |
| `pnpm tauri dev` 热更新 | 一直走的 release 构建，开发模式的热更新流程未实测 |
| 大书库性能 | 目前书本数量很少。书多了之后封面网格需要虚拟滚动 |

---

## 三、阶段 2：中文排版 + 批注 + 全文搜索

### 3.1 中文排版

**背景**：现在正文排版用的是通用 CSS（两端对齐 + 行高），没有针对中文做优化。

**要做**：
- 首行缩进 2 字符（中文书籍惯例；英文书不该缩进，需要按语言判断）
- 标点挤压（行首不出现 `，`、`。` 等）；CSS 已有 `hanging-punctuation`
  但 WebKit 支持有限，可能需要用 `text-spacing` 或手动处理
- 中西文自动间距
- 中文断行规则（避免标点出现在行首）

**建议**：JS 里可以用 `navigator.language` / 书籍 metadata 的 `language`
判断是否 CJK，在 `buildCss()` 里输出不同规则。
引擎返回的 `BookInfo.language` 已经带了这个信息，目前 UI 还没用上。

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

1. **先修滚轮**（§2.1）——改动最小、体感提升最大，半小时内能完成并验证
2. **实测 Android 真机**（§2.2）——确认双端一致
3. 然后按阶段 2 → 3 → 4 推进，每完成一块就出包给用户验收

> 每次改动界面后，**务必用 AGENTS.md §5.4 的 CDP 方法驱动真实应用验证一遍**。
> 阶段 1 有三个「构建全绿、功能全废」的 bug 就是这样抓出来的。
