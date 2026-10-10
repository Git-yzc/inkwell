# 需求：把 epub 文件直接交给砚池打开（2026-10-10）

> **状态：✅ 已实现（0.2.2，2026-10-10）。** Windows 侧已实测验收；
> Android 侧代码与清单已就位、**真机未验**（见 §八）。
> 相关：[BACKLOG.md](BACKLOG.md) §2.8、[AGENTS.md](../AGENTS.md) §7。
>
> 本文保留需求原文、决策记录与验收口径（§一–§七），**实现与验收结果见 §八**。

---

## 一、需求原文（用户）

> 我发现我现在的这个 epub 阅读器，不支持即时打开 epub 文件，而是需要先导入后才能阅读。
> 当我把这个 epub 阅读器设置为默认 epub 阅读器的时候，点击新的 epub 文件，
> 只会启动这个软件进入书架页面，而不会打开阅读器阅读。

一句话：**「打开方式」/ 双击 epub 应该直接进阅读器，而不是停在书库。**

---

## 二、期望行为（已按决策定案）

1. **冷启动**：双击一个**尚未入库**的 epub → 应用启动后自动「**导入到书库 + 进阅读器**」（Q1）。
2. **已入库的书**：同一本书（指纹相同）再次打开 → 跳到库里**已有的那本**，
   **不新增记录**，且**直接落到上次读到的位置**（Q4）。后者是现成能力：
   [`src/routes/Reader.tsx:227-231`](../src/routes/Reader.tsx) 已经把
   `progressCfi` / `progressPct` 交给引擎，引擎
   [`index.ts:368-378`](../src/features/reader/engine/index.ts) 据此落位 ——
   **跳到 `/read/:id` 即自带续读**，不需要为 Q4 另写逻辑。
3. **应用已在运行时再打开**：**新开一个窗口**（Q3），不做单实例转发。
   也就是说"每次打开 = 一个新进程"是本需求的**预期行为**，不是缺陷。
4. **无参数启动**：与 0.2.1 完全一致（进书库）—— 回归项，必测。
5. **一次给多个文件**：**只打开第一个**，其余不动（Q5）。
6. **失败兜底**：不支持的后缀 / 损坏文件 → 回书库并用中文提示，不白屏、不静默。
7. **Android**：同时支持「用砚池打开」（`ACTION_VIEW`）与「分享到砚池」（`ACTION_SEND`）（Q6）。
8. **可分发**（Q6 的言外之意：要给别人用）：Windows 安装包与已签名 APK 装到别人的机器上，
   关联 / 分享入口同样可用。

---

## 三、现状与证据（为什么现在打不开）

已逐条在仓库里查证（不是推测）：

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | **没有注册文件关联** | `src-tauri/tauri.conf.json` 的 `bundle` 段里**没有 `fileAssociations`**（全仓库 grep 零命中）→ 安装包不会写关联。你现在能"设为默认"，**应当是**手工在 Windows「打开方式 → 选择其他应用」里指到 `inkwell.exe` 的（这一条是推断，待确认） |
| 2 | **命令行参数被完全丢弃** | 源码 `src-tauri/src/main.rs:4-6` 只有 `inkwell_lib::run()`；全仓库 grep `env::args` / `args()` **零命中**。手工关联之后，系统只会把文件路径当 `argv[1]` 传给进程，而没人读它 |
| 3 | **所以只进默认路由** | 源码 `src/App.tsx:8-12`：hash 路由只有 `/`（书库）与 `/read/:id`（阅读器）。没有"待打开文件"这个入口，启动自然停在书库 |
| 4 | **导入接口不返回 id** | `import_books(paths)`（源码 `src-tauri/src/lib.rs:308`）已经能收「绝对路径或 URI」，但 `ImportSummary`（源码 `src-tauri/src/library.rs:51-57`）只有 `imported / duplicates / failed` 三个计数与名字列表，**不返回 `bookId`** → 前端即使拿到了"导入成功"也跳不过去；重复书（`duplicates`）同样只有文件名，拿不到库里那本的 id —— **这正好卡住 Q4** |
| 5 | **Android 连入口都没有** | 源码 `src-tauri/gen/android/app/src/main/AndroidManifest.xml:19-24` 的 intent-filter 只有 `MAIN` / `LAUNCHER`，没有 `ACTION_VIEW`（也没 `ACTION_SEND`）→ 系统根本不会把 epub 递进来。另外 SAF 交回来的是 `content://` URI（这一条链路**已有现成方案**，见 BACKLOG §2.4） |
| 6 | **多实例写库没有保护** | 源码 `src-tauri/src/db.rs:95` 开了 `journal_mode = WAL`，但全文件 grep `busy_timeout` **零命中**；rusqlite 默认 busy timeout 为 0 → Q3 选了"新开窗口"之后，两个实例同时写进度 / 批注会**立刻**报 `database is locked`（不做保护的话） |

> 结论：这不是"打开逻辑写错了"，而是**入口整条链都没搭** ——
> 注册关联 → 读命令行 → 导入并回 id → 前端跳阅读器，四段里一段都没有。
> （Q3 选了新开窗口，所以**不需要单实例插件**这一段。）

---

## 四、实现方案（按定案收敛）

1. **注册关联**：`src-tauri/tauri.conf.json` 的 `bundle` 加
   `fileAssociations`，**只注册 `epub`**（Q2）。
   注意：Windows 的 `UserChoice` 有哈希保护，**程序不能抢默认**，我们只能注册"我能打开"，
   仍需用户在系统设置里选一次 —— 这不影响本需求（用户自己就是手工设的）。
2. **读参数**：`main.rs` / `lib.rs` 启动时取 `std::env::args()`，筛出可识别的
   **第一个** epub 路径（Q5），存进 `AppState` 的 `pending_open` 槽。
3. **不做单实例**（Q3）：不引入 `tauri-plugin-single-instance`。
   → **本需求不新增任何依赖**，Windows 侧纯粹是"读 argv + 注册关联 + 跳路由"。
4. **回 id**（本需求**唯一必须动的后端接口**）：`ImportSummary` 增补
   `imported_ids: Vec<String>` 与 `duplicate_ids: Vec<String>`（或统一成
   `Vec<{name, id, status}>`），否则 Q4「跳已入库那本」没有 id 可用。
   改动会牵到 `import_books` 的调用方，注意现有导入提示（`Library.tsx`）的兼容。
5. **前端**：加一个「打开文件」入口 —— 启动时 invoke 一个 `pending_open`，
   拿到 id 后 `navigate('/read/' + id)`。要处理 **RouterProvider 尚未挂载**的时序
   （Tauri 的启动 invoke 可能早于路由就绪）。Q4 的续读不用另外做（见 §二-2）。
6. **Android**：`MainActivity` 加 `ACTION_VIEW`（epub 的 mimeType + 扩展名）与
   `ACTION_SEND`（Q6），把 Intent 里的 URI 交给 Rust —— **现无此通道，要新写**。
   `gen/android` 是生成物，改动存活策略要一并确认（仓库已有 `src-tauri/tauri.js` 这类适配层先例）。
   递进来的 `content://` 走导入那条**已有**的落地链路（BACKLOG §2.4）。
7. **多实例写库**（Q3 的必然后果，**开工就得一起做**）：给源码 `src-tauri/src/db.rs`
   的连接设 `busy_timeout`（如 5s），否则两个窗口同时存进度会报错。
   几行的事，但不做就是"能开两个窗口、第二个存不上"。

---

## 五、决策记录（2026-10-10 已定案）

| # | 问题 | **用户定案** | 影响 |
| --- | --- | --- | --- |
| Q1 | 打开是导入再读，还是临时打开？ | **导入到书库再读** | 沿用现有数据模型，进度 / 批注都能存；无需临时文件生命周期管理 |
| Q2 | 关联哪些后缀？ | **只 epub** | 安装包只注册 epub；日后要扩格式再改这一处 |
| Q3 | 已在运行时复用还是新开？ | **新开窗口** | 省掉单实例插件（**不引入新依赖**）；但必须补 `busy_timeout`（§三-6） |
| Q4 | 重复书怎么办？ | **跳已有的，并续读上次位置** | 需要 `duplicate_ids`；续读是现成能力 |
| Q5 | 多文件怎么办？ | **只打开第一个** | 参数筛选只取一个；其余忽略，不弹额外 UI |
| Q6 | Android 只做打开还是也做分享？ | **两个都做**（且要能给别人用） | `ACTION_VIEW` + `ACTION_SEND`；验收要覆盖"装到别人机器 / 别人手机" |

---

## 六、验收标准

- **冷启动**：`inkwell.exe <新epub路径>` → 最终落在 `/read/<id>`（用 BACKLOG §5.4 的 CDP 或日志核对），
  书在库中且能正常翻页；
- **重复书 + 续读**：`list_books` 数量不变，直接进阅读器，**且停在上次读到的位置**
  （先读到某处退出，再双击同一个 epub，对比 CFI / 页码）；
- **新开窗口**：应用在跑时再次打开 epub → **出现第二个窗口**并进阅读器（Q3 的预期行为）；
  两个窗口各自翻页、各自存进度，**不出现 `database is locked`**；
- **无参数启动**：与 0.2.1 完全一致（进书库）—— 回归项，必测；
- **多文件**：一次传两个 epub → 只打开第一个；
- **坏输入**：不支持的扩展名 / 损坏文件 → 进程不崩、书库可用、有中文错误提示；
- **Android**：从文件管理器「用砚池打开」epub → 进阅读器；从别的应用「分享到砚池」→ 同样进阅读器（真机）；
- **分发**：在**别人**的机器上装 Windows 包 → 能通过「打开方式」选到砚池并正常打开
  （不要求自动成为默认，那是系统限制）；APK 装到别人手机同样可用；
- 以上每条都要有**真实执行过的命令与输出**（AGENTS.md 铁律 7）。

---

## 七、风险 / 未验证的点

| 项 | 说明 |
| --- | --- |
| **多实例写库**（新增，Q3 直接带出来的） | `db.rs` 有 WAL 但无 `busy_timeout`（§三-6）。不补的话两个窗口抢写会报 `database is locked` —— **这条必须在实现里一起解决，并作为验收项** |
| 手工关联会干扰验证 | 用户已在系统里手工设过默认；测试前先清掉手工关联（`HKCU\Software\Classes` 与 `UserChoice`），否则分不清是安装器注册的生效还是旧的生效 |
| 不能抢默认 | `UserChoice` 有哈希保护，程序只能注册能力、不能强制成为默认 —— 验收口径是"注册后用户能在系统设置里选到"，不是"自动变默认" |
| Android URI 权限 | `ACTION_VIEW` / `ACTION_SEND` 递进来的 `content://` 需要 `FLAG_GRANT_READ_URI_PERMISSION` 才读得到，必须在真机上验（本机验不了） |
| Android 生成物 | 清单改动在 `gen/android` 里，要确认重新生成 Android 工程时不会被覆盖掉 |
| 出包后才生效 | 关联写在安装包（NSIS）里，**改完必须重新出包安装再验**，`pnpm tauri dev` 下看不到关联效果 |
| 给别人用的前置 | 分发用已签名 APK（`build-android.ps1` 已做签名校验）与 `Downloads\Inkwell\` 那份安装包（BACKLOG §2.6 ⑥：仓库里的安装包会被沙箱限制，**别给 `personal/out/` 里的那份**） |

---

## 八、实现与验收记录（0.2.2，2026-10-10）

**已实现并出包。** 逐项命令与输出见 [BACKLOG.md](BACKLOG.md) §2.8 的验收表；
这里只记与本文档（决策 / 验收口径）直接相关的结论。

| 决策 | 落地情况 |
| --- | --- |
| Q1 导入再读 | ✅ 冷启动带新 epub：日志 `系统要求打开：…` → `已导入：…`，随后直接落在 `#/read/<id>` |
| Q2 只关联 epub | ✅ `bundle.fileAssociations` 只列 `epub`；生成的 NSIS 里有 `APP_ASSOCIATE "epub"`（卸载侧有 `APP_UNASSOCIATE`） |
| Q3 新开窗口 | ✅ 不做单实例（**因此没有引入任何新依赖**）；两个实例同时打开同一本实测都正常，并发写库由 `busy_timeout` 兜住 |
| Q4 跳已有 + 续读 | ✅ books 目录仍只有 1 个文件、跳到**同一个 id**；把位置放到 0.6211 后重开，`lastLocation.fraction` 仍为 0.6211 |
| Q5 只开第一个 | ✅ `first_openable_arg` 只取第一个受支持的文件；无参数启动回归通过 |
| Q6 Android 打开+分享 | ⚠️ 代码与清单已就位（`ACTION_VIEW` + `ACTION_SEND` → `OpenFilePlugin.kt` → `takePending`），**真机未验** |
| §六 坏输入 | ✅ 不支持的扩展名被忽略（照常进书库）；坏掉的 epub 导入后阅读器显示「打开失败：…」+「返回书库」，进程不崩 |

**仍未满足的验收项**（不要当成已完成）：

- **Android 真机**的「用砚池打开 / 分享到砚池」端到端 —— 本机没有连接设备，验不了。
- 「别人的机器上装完能在打开方式里选到砚池」—— 本机只能验到脚本/注册表层
  （`installer.nsi` 确实写了 `APP_ASSOCIATE`；`UserChoice` 有哈希保护，程序本就抢不了默认），
  真正的异机验证要等有人装一次。
- 「应用已在运行时双击 epub」在 **Android** 上走的是 `onNewIntent`（清单是 `singleTask`），
  与 Windows 的「新开窗口」语义不同 —— 这段逻辑**没有真机验证过**。
