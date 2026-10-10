/**
 * 「用砚池打开」：把系统递进来的文件导入书库并直接进阅读器。
 *
 * 两个来源都汇到这里 —— 桌面端是双击 epub / 「打开方式」（命令行参数），
 * Android 是「打开」/「分享」（Intent）。取文件那一步由 Rust 统一收着。
 */
import { api } from '@/lib/api';
import { useLibrary } from '@/store/library';

/**
 * 取一次系统递进来的文件并导入，返回要跳转的那本书的 id。
 *
 * 没有文件、或导入失败时返回 `null`：前者是正常启动，后者会带上中文原因
 * （`failed` 非空），由调用方提示，不要在这里静默吞掉。
 */
export async function openSystemFile(): Promise<
  { id: string } | { error: string } | null
> {
  // 取不到（比如 Android 侧插件没起来）就当没有，不能把启动搞崩。
  const paths = await api.takePendingOpen().catch(() => [] as string[]);
  if (paths.length === 0) return null;

  const result = await useLibrary.getState().importPaths(paths);
  if (!result) return { error: '导入失败，未能打开这个文件' };

  // 新导入的优先；已经在库里的（内容重复）就跳库里那本 —— 它会自带续读上次位置。
  const id = result.importedIds[0] ?? result.duplicateIds[0];
  if (id) return { id };

  return { error: result.failed[0] ?? '这个文件打不开' };
}
