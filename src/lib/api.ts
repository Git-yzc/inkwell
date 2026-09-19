/**
 * Rust 后端的类型化封装。
 *
 * 约定：前端不写 SQL、不碰文件系统，所有数据操作都经这里走 Tauri command。
 * 字段名与 src-tauri/src/lib.rs 里的结构体一一对应（Rust 侧用了 camelCase 序列化）。
 */
import { invoke } from '@tauri-apps/api/core';

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  dataDir: string | null;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  format: string;
  /** 相对书库根目录的文件名 */
  filePath: string;
  coverPath: string | null;
  fileSize: number;
  addedAt: number;
  lastOpenedAt: number | null;
  progressCfi: string | null;
  progressPct: number;
  finished: boolean;
  /** 书籍文件的绝对路径 */
  absPath: string;
  /** 封面缩略图的绝对路径 */
  coverAbsPath: string | null;
}

export interface ImportSummary {
  imported: number;
  /** 因内容重复而跳过的文件名 */
  duplicates: string[];
  /** 导入失败的「文件名：原因」 */
  failed: string[];
}

export const api = {
  appInfo: () => invoke<AppInfo>('app_info'),
  listBooks: () => invoke<Book[]>('list_books'),
  getBook: (id: string) => invoke<Book | null>('get_book', { id }),
  importBooks: (paths: string[]) => invoke<ImportSummary>('import_books', { paths }),
  deleteBook: (id: string) => invoke<void>('delete_book', { id }),
  touchBook: (id: string) => invoke<void>('touch_book', { id }),
  saveProgress: (id: string, cfi: string | null, pct: number) =>
    invoke<void>('save_progress', { id, cfi, pct }),
  renameBook: (id: string, title: string, author: string | null) =>
    invoke<void>('rename_book', { id, title, author }),
};

/** Rust 侧的 Error 会序列化成字符串，这里统一转成可展示的中文文案。 */
export function readableError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
