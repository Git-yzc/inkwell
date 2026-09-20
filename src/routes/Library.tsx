import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import BookCard from '@/components/BookCard';
import { api, type Book } from '@/lib/api';
import { type SortKey, selectVisibleBooks, useLibrary } from '@/store/library';

/** 与 backend library.rs 支持的格式保持一致。 */
const BOOK_EXTENSIONS = ['epub', 'mobi', 'azw3', 'azw', 'fb2', 'cbz', 'pdf', 'txt', 'md'];

const SORT_LABELS: Record<SortKey, string> = {
  recent: '最近阅读',
  added: '最近导入',
  title: '按书名',
  author: '按作者',
};

export default function Library() {
  const navigate = useNavigate();
  const allBooks = useLibrary((s) => s.books);
  const total = allBooks.length;
  const loading = useLibrary((s) => s.loading);
  const error = useLibrary((s) => s.error);
  const query = useLibrary((s) => s.query);
  const sort = useLibrary((s) => s.sort);
  const refresh = useLibrary((s) => s.refresh);
  const importPaths = useLibrary((s) => s.importPaths);
  const remove = useLibrary((s) => s.remove);
  const setQuery = useLibrary((s) => s.setQuery);
  const setSort = useLibrary((s) => s.setSort);

  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Book | null>(null);
  /**
   * 版本号。
   *
   * 显示出来是有实际用途的：这个 App 只在手机上装、迭代又频繁，
   * 而安装包文件名以前一直不变，光看界面分不清装的是哪一版
   * （真发生过：以为装上了新版，其实还是旧包）。
   */
  const [version, setVersion] = useState<string | null>(null);

  // 派生列表必须用 useMemo：selectVisibleBooks 每次返回新数组，
  // 直接交给 zustand 选择器会导致无限重渲染。
  const books = useMemo(
    () => selectVisibleBooks({ books: allBooks, query, sort }),
    [allBooks, query, sort],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void api
      .appInfo()
      .then((info) => setVersion(info.version))
      .catch(() => {
        // 拿不到版本号不影响用，不显示就是了
      });
  }, []);

  async function handleImport() {
    setNotice(null);
    const picked = await openDialog({
      multiple: true,
      title: '选择要导入的书',
      filters: [{ name: '电子书', extensions: BOOK_EXTENSIONS }],
    });
    if (!picked) return;

    const paths = Array.isArray(picked) ? picked : [picked];
    const result = await importPaths(paths);
    if (!result) return;

    const parts: string[] = [];
    if (result.imported > 0) parts.push(`成功导入 ${result.imported} 本`);
    if (result.duplicates.length > 0) parts.push(`跳过重复 ${result.duplicates.length} 本`);
    if (result.failed.length > 0) parts.push(`失败 ${result.failed.length} 本`);
    setNotice(parts.length > 0 ? parts.join('，') : '没有导入任何书');

    if (result.failed.length > 0) {
      // 失败原因可能较长，这里只提示前两条，完整信息可在日志里查
      setNotice((prev) => `${prev}：${result.failed.slice(0, 2).join('；')}`);
    }
  }

  async function handleOpen(book: Book) {
    navigate(`/read/${book.id}`);
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="sticky top-0 z-10 border-b border-neutral-800/80 bg-neutral-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
          <h1 className="font-serif text-xl tracking-[0.2em] text-amber-100/90">
            砚池
            {version !== null && (
              <span className="ml-1.5 align-middle font-sans text-[10px] tracking-normal text-neutral-600">
                v{version}
              </span>
            )}
          </h1>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索书名或作者"
            className="min-w-40 flex-1 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm outline-none placeholder:text-neutral-600 focus:border-amber-200/40"
          />

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="cursor-pointer rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm outline-none focus:border-amber-200/40"
          >
            {Object.entries(SORT_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={handleImport}
            disabled={loading}
            className="cursor-pointer rounded bg-amber-200/90 px-3.5 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-amber-100 disabled:opacity-50"
          >
            导入书籍
          </button>
        </div>

        {(notice !== null || error !== null) && (
          <div className="mx-auto max-w-6xl px-5 pb-2.5">
            {error !== null && <p className="text-xs text-red-400">{error}</p>}
            {notice !== null && error === null && (
              <p className="text-xs text-neutral-400">{notice}</p>
            )}
          </div>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-5 py-6">
        {loading && total === 0 && <p className="text-sm text-neutral-500">正在读取书库…</p>}

        {!loading && total === 0 && (
          <div className="mt-24 text-center">
            <p className="font-serif text-2xl text-neutral-600">书库是空的</p>
            <p className="mt-2 text-sm text-neutral-600">点「导入书籍」，选几本 EPUB 试试</p>
          </div>
        )}

        {total > 0 && books.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-500">没有匹配「{query}」的书</p>
        )}

        {books.length > 0 && (
          <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {books.map((b) => (
              <BookCard key={b.id} book={b} onOpen={handleOpen} onDelete={setPendingDelete} />
            ))}
          </div>
        )}
      </main>

      {pendingDelete !== null && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 px-5">
          <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-5">
            <p className="text-sm text-neutral-200">确定删除《{pendingDelete.title}》？</p>
            <p className="mt-1.5 text-xs text-neutral-500">
              书籍文件、封面与阅读记录都会一并删除，无法恢复。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="cursor-pointer rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = pendingDelete;
                  setPendingDelete(null);
                  void remove(target.id);
                }}
                className="cursor-pointer rounded bg-red-800 px-3 py-1.5 text-sm text-red-50 hover:bg-red-700"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
