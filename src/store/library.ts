/**
 * 书库状态。
 *
 * 只做「数据缓存 + 操作编排」，不掺 UI 逻辑：
 * 组件从 books 读，改动一律走这里的 action，action 完成后刷新列表。
 */
import { create } from 'zustand';

import { api, type Book, readableError } from '@/lib/api';

export type SortKey = 'recent' | 'added' | 'title' | 'author';

export interface ImportResult {
  imported: number;
  duplicates: string[];
  failed: string[];
}

interface LibraryState {
  books: Book[];
  loading: boolean;
  error: string | null;

  /** 搜索关键词（按书名/作者过滤） */
  query: string;
  sort: SortKey;

  refresh: () => Promise<void>;
  importPaths: (paths: string[]) => Promise<ImportResult | null>;
  remove: (id: string) => Promise<void>;
  setQuery: (q: string) => void;
  setSort: (s: SortKey) => void;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  books: [],
  loading: false,
  error: null,
  query: '',
  sort: 'recent',

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const books = await api.listBooks();
      set({ books, loading: false });
    } catch (e) {
      set({ error: readableError(e), loading: false });
    }
  },

  importPaths: async (paths) => {
    if (paths.length === 0) return null;
    set({ loading: true, error: null });
    try {
      const summary = await api.importBooks(paths);
      await get().refresh();
      return {
        imported: summary.imported,
        duplicates: summary.duplicates,
        failed: summary.failed,
      };
    } catch (e) {
      set({ error: readableError(e), loading: false });
      return null;
    }
  },

  remove: async (id) => {
    try {
      await api.deleteBook(id);
      // 本地先摘掉，界面立刻有反馈；再从后端拉一次保证一致
      set({ books: get().books.filter((b) => b.id !== id) });
      await get().refresh();
    } catch (e) {
      set({ error: readableError(e) });
    }
  },

  setQuery: (query) => set({ query }),
  setSort: (sort) => set({ sort }),
}));

/**
 * 按搜索词与排序方式算出要显示的列表。
 *
 * ⚠️ 参数刻意只收「纯数据」而不是整个 store 对象。
 * 它每次都会返回**新数组**：若直接写 `useLibrary(selectVisibleBooks)`，
 * zustand 用 Object.is 比较选择器结果，新数组永远不等于旧值，
 * React 会陷入无限重渲染（实测表现为 React error #185，整个书库白屏）。
 * 正确用法：分别订阅 books/query/sort，再用 useMemo 调本函数。
 */
export function selectVisibleBooks(input: { books: Book[]; query: string; sort: SortKey }): Book[] {
  const q = input.query.trim().toLowerCase();
  const filtered = q
    ? input.books.filter(
        (b) => b.title.toLowerCase().includes(q) || (b.author ?? '').toLowerCase().includes(q),
      )
    : input.books;

  const sorted = [...filtered];
  switch (input.sort) {
    case 'title':
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
      break;
    case 'author':
      sorted.sort((a, b) =>
        (a.author ?? '\uffff').localeCompare(b.author ?? '\uffff', 'zh-Hans-CN'),
      );
      break;
    case 'added':
      sorted.sort((a, b) => b.addedAt - a.addedAt);
      break;
    default:
      // recent：有打开记录的排前面，其余按加入时间
      sorted.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.addedAt - a.addedAt);
  }
  return sorted;
}
