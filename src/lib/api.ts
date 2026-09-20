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

/** 批注类型：划词高亮（可带笔记）与书签。 */
export type AnnotationKind = 'highlight' | 'bookmark';

/** 高亮色名。色值由前端映射，库里只存色名（见 annotation.rs 的说明）。 */
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export interface Annotation {
  id: string;
  bookId: string;
  type: AnnotationKind;
  /** EPUB CFI：高亮是 range，书签是点 */
  cfi: string;
  /** 被划线的原文（书签为 null） */
  text: string | null;
  note: string | null;
  color: HighlightColor | null;
  /** 所在章节标题 */
  chapter: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 导出格式。 */
export type ExportFormat = 'markdown' | 'json';

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

  listAnnotations: (bookId: string) => invoke<Annotation[]>('list_annotations', { bookId }),
  addAnnotation: (input: {
    bookId: string;
    kind: AnnotationKind;
    cfi: string;
    text?: string | null;
    note?: string | null;
    color?: HighlightColor | null;
    chapter?: string | null;
  }) => invoke<Annotation>('add_annotation', input),
  updateAnnotation: (id: string, note: string | null, color: HighlightColor | null) =>
    invoke<void>('update_annotation', { id, note, color }),
  deleteAnnotation: (id: string) => invoke<void>('delete_annotation', { id }),
  /** 导出到指定路径，返回写入的条目数。写文件在 Rust 侧做，前端没有任意路径权限。 */
  exportAnnotations: (bookId: string, path: string, format: ExportFormat) =>
    invoke<number>('export_annotations', { bookId, path, format }),
};

/** Rust 侧的 Error 会序列化成字符串，这里统一转成可展示的中文文案。 */
export function readableError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
