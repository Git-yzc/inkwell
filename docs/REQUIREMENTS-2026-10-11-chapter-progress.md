# 需求：页号角标改成「当前章节的进度」（2026-10-11）

> **状态：📝 已记录，待定案 / 待排期。** 用户 2026-10-11 提出，属**下一版本**的需求。
> 相关：[BACKLOG.md](BACKLOG.md)（§九）、[AGENTS.md](../AGENTS.md) §7。
>
> 本文只记录需求与现状证据、列出**待用户拍板的决策点（§四）**；决策定下来之前不动代码。

---

## 一、需求原文（用户）

> 记录一下下一个版本的需求，页码显示这里，当 epub 文件有分章节的时候，
> 页号的进度显示为当前章节的进度，百分比和进度条则还是保持全书进度。

配图（阅读《毛泽东传(共6册)》「十五、长征」一章）：右下角角标当前是

```
611 / 4443   14%
```

一句话：**角标里的「611 / 4443」这类页号，改成只反映当前章节的进度；
百分比（`14%`）与底栏进度条仍表示全书进度。**

---

## 二、现状（逐条已在仓库里查证）

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 右下角角标 = `position.current / position.total`，紧跟全书百分比 | 源码 [`src/routes/Reader.tsx:744-756`](../src/routes/Reader.tsx) |
| 2 | `position` 来自引擎每次 `relocate` 回调里的 `positionCurrent` / `positionTotal` | 源码 [`src/routes/Reader.tsx:175-180`](../src/routes/Reader.tsx)；类型 [`engine/types.ts:19-29`](../src/features/reader/engine/types.ts) |
| 3 | 可重排书籍（EPUB 等）取内核折算的**全书**位置（Kindle 式 `Loc`），非真实页码 | 源码 [`engine/index.ts:147-167`](../src/features/reader/engine/index.ts)（`toLocation()`）；内核 `location.current/total` 由 `sizePerLoc = 1500` 折算，见 [`packages/foliate-js/view.js:242`](../packages/foliate-js/view.js) 与 [`progress.js:88-92`](../packages/foliate-js/progress.js) |
| 4 | 固定版式（PDF / 漫画）已经是**页码**（一页 = 一节） | 同 `toLocation()` 的 `usePages` 分支 |
| 5 | 百分比与底栏进度条只用 `loc.fraction`（全书进度） | 源码 [`src/routes/Reader.tsx:808-832`](../src/routes/Reader.tsx) |

也就是说：**要改的只有角标那一处数字来源，百分比与进度条一行都不用动。**

---

## 三、期望行为

1. **有分章节的 EPUB**：角标显示**当前章节内**的进度（形式待定，见 §四 Q2），
   例如当前章共 240 个内核位置、读到第 12 个 → `12 / 240`。
2. **百分比与进度条**：保持**全书**进度不变（角标里那个 `14%` 与底栏那根条）。
3. **没有分章节的书**（单节 / 无目录）：回退成现在的全书位置，行为与改动前一致。
4. **固定版式（PDF / 漫画）**：保持现在的**页码**语义，不套「章内进度」。
5. **翻页模式与滚动模式**行为一致。
6. 跨章时角标数字**回到章首**（相对该章重新计数），而不是继续累加。

---

## 四、待用户拍板的决策点

> 这几条会直接影响实现量与「改了之后是不是你想要的」，**定案前不动代码**。

### Q1：「章节」按谁的口径？

| 方案 | 含义 | 成本 | 风险 |
| --- | --- | --- | --- |
| **A. 内核的 spine 分节**（推荐先做） | 每个 xhtml 文件算一节；正文整本一个文件的不算分章 | **低**——内核已有现成 API（见 §五） | 若某本书整本正文在一个 xhtml 里、只靠锚点分章，会「看不出分章」，退化成全书进度 |
| B. 目录项（TOC item） | 以目录里的一「章」为准，最贴近用户直觉 | 高——目录项可能跨/共享 spine 节，要靠 href + 锚点换算位置 | 需要额外解析与边界处理，改动面大 |

> 判断依据：用户手上这本《毛泽东传(共6册)》若是一章一个 xhtml，方案 A 的效果与 B 等价。
> **建议先用 A 交付，真读起来发现哪本书不生效，再按 B 升级。**

### Q2：角标数字用什么单位？

- A. **沿用现在的单位**（内核折算的「位置数」），只是**限定在章内**：`12 / 240`。改动最小、与现状视觉一致（推荐）。
- B. 章内百分比（如 `本章 5%`）—— 会与紧跟其后的全书百分比混淆，不推荐。
- C. 真实页码 —— 可重排书籍的页码随字号/窗口变化，内核不提供稳定页码，不推荐。

### Q3：要不要在角标上标出章名？

顶栏已经显示当前章名（[`Reader.tsx:624`](../src/routes/Reader.tsx)，截图里就是「十五、长征」），
角标默认**不加**，避免重复。若希望角标自带章名请提出。

### Q4：无分章 / 单节书怎么显示？

默认回退为现在的全书位置（Q1 方案 A 下天然如此）。是否改成只显示百分比，待定。

---

## 五、实现路径（决策定案后）

内核已提供现成能力，**不需要动 submodule**：

- `view.getSectionFractions()` —— 公开方法，返回每一节的分界累计比例（长度 = 节数 + 1），
  见 [`packages/foliate-js/view.js:490-493`](../packages/foliate-js/view.js)。
- `SectionProgress.sectionFractions` / `getSection()` —— 同一个数组与反查，
  见 [`packages/foliate-js/progress.js:58-112`](../packages/foliate-js/progress.js)。
- `relocate` 事件详情里已有 `section.current`（从 0 开始的节号）与全书 `fraction`、
  `location.current/total`，见 [`view.js:329-338`](../packages/foliate-js/view.js)。

落地步骤（预计只碰三处）：

1. **适配层**（[`src/features/reader/engine/index.ts`](../src/features/reader/engine/index.ts)）：
   在 `toLocation()` 里用 `view.getSectionFractions()` + `raw.section.current` 推出章内进度，新增字段，例如
   `sectionPositionCurrent` / `sectionPositionTotal`（或直接给 `sectionFraction: 0..1`）。
   章内比例：`p = (fraction - sf[i]) / (sf[i+1] - sf[i])`，夹到 `[0, 1]`。
2. **类型**（[`engine/types.ts`](../src/features/reader/engine/types.ts)）：给 `ReaderLocation` 补字段，
   写清「章内 / 全书」两种语义，避免以后混用。
3. **UI**（[`src/routes/Reader.tsx`](../src/routes/Reader.tsx)）：角标改用章内字段；
   总数拿不到（单节 / 固定版式）时回退现在的 `position`。**底栏与百分比不改。**

> ⚠️ 精度提示：`location.total` 是 `ceil(sizeTotal / sizePerLoc)` 折算值，
> 用它按比例反推章内总数会有 ±1 的取整误差；更稳的是引擎侧直接读
> `book.sections[index].size` 计算。实现时先实测几本书再定，
> 别让角标出现 `13 / 240` 却永远到不了 240 这种别扭值。

---

## 六、验收标准（实现后按此验）

1. **有分章 EPUB**（拿《毛泽东传(共6册)》）：翻到「十五、长征」某页，
   角标数字随章内翻页递增；**跨到下一章时归 1**；总数不超过该章实际长度。
2. 同一次翻页中，**百分比与底栏进度条仍按全书**单调递增，不受角标改动影响。
3. **无分章 / 单节书**：角标与改动前完全一致（回归项）。
4. **PDF**：角标仍是页码（回归项）。
5. `pnpm typecheck` / `pnpm lint` 干净；按 [AGENTS.md](../AGENTS.md) §5.4
   用 CDP 驱动**真实应用**验证，不接受只看构建通过。

---

## 七、决策记录

| 日期 | 事项 | 结论 |
| --- | --- | --- |
| 2026-10-11 | 用户提出需求 | 已记录原文（§一） |
| — | Q1 章节口径 / Q2 单位 / Q3 章名 / Q4 回退 | **待定** |
