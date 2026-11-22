import { useEffect, useRef, useState } from 'react';

import type { SearchEvent, SearchHit } from '@/features/reader/engine/types';

interface Props {
  /** 引擎的全书搜索；每次调用返回一个新的异步迭代器 */
  onSearch: (query: string) => AsyncGenerator<SearchEvent>;
  /** 点结果跳转（不关闭面板，方便连续查看） */
  onSelect: (cfi: string) => void;
  onClose: () => void;
}

interface Group {
  label: string;
  items: SearchHit[];
}

/** 单本全文搜索侧栏（REQ-2026-11-22-01）。 */
export default function SearchPanel({ onSearch, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState(0);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 一次只渲染前 200 条：常见词在几十万字的书里可能命中上万条，全渲染会卡 */
  const [visible, setVisible] = useState(200);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 每次搜索 / 卸载都 +1，旧的异步循环看到不一致就停，不再 setState */
  const runRef = useRef(0);
  const searchingRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      // 卸载时让还在跑的循环停下（引擎侧的描边由 Reader 的 closeSearch 清）
      runRef.current++;
    };
  }, []);

  const total = groups.reduce((n, g) => n + g.items.length, 0);

  // 按顺序截取前 visible 条，分组标题跟着保留；避免一次挂上万个 DOM 节点
  const shownGroups: Group[] = [];
  let remain = visible;
  for (const group of groups) {
    if (remain <= 0) break;
    const items = group.items.slice(0, remain);
    if (items.length > 0) shownGroups.push({ label: group.label, items });
    remain -= items.length;
  }

  async function runSearch() {
    const q = query.trim();
    if (!q || searchingRef.current) return;

    const run = ++runRef.current;
    searchingRef.current = true;
    setSearching(true);
    setSearched(true);
    setError(null);
    setGroups([]);
    setProgress(0);
    setVisible(200);

    try {
      for await (const event of onSearch(q)) {
        if (run !== runRef.current) break;
        if (event.kind === 'progress') {
          setProgress(event.progress);
        } else if (event.kind === 'results') {
          setGroups((list) => [...list, { label: event.label, items: event.items }]);
        } else {
          break;
        }
      }
      if (run === runRef.current) setProgress(1);
    } catch (e) {
      if (run === runRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (run === runRef.current) {
        searchingRef.current = false;
        setSearching(false);
      }
    }
  }

  return (
    <aside className="flex h-full w-80 flex-col border-l border-app-border bg-app-surface">
      <header className="flex items-center justify-between border-b border-app-border px-4 py-3">
        <h2 className="text-sm text-app-fg">全文搜索</h2>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer px-1 text-app-muted hover:text-app-fg"
          aria-label="关闭"
        >
          ✕
        </button>
      </header>

      <form
        className="flex items-center gap-2 border-b border-app-border px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
      >
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索这本书"
          aria-label="搜索关键词"
          className="min-w-0 flex-1 rounded border border-app-border bg-app-surface-strong px-2 py-1.5 text-sm text-app-fg outline-none placeholder:text-app-muted focus:border-amber-500/70"
        />
        <button
          type="submit"
          disabled={searching || query.trim() === ''}
          className="shrink-0 cursor-pointer rounded border border-app-border px-2 py-1.5 text-xs text-app-fg hover:border-app-muted disabled:cursor-default disabled:opacity-40"
        >
          {searching ? '搜索中…' : '搜索'}
        </button>
      </form>

      {searching && (
        <div className="h-0.5 bg-app-border">
          <div
            className="h-full bg-amber-500 transition-[width] duration-200"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-1.5 text-[11px] text-app-muted">
        <span>
          {searching ? `正在搜索… ${Math.round(progress * 100)}%` : searched ? `共 ${total} 处` : ''}
        </span>
        {searched && !searching && total > 0 && (
          <span>
            {groups.length} 个章节
            {total > visible ? ` · 已显示 ${visible}` : ''}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        {error !== null && <p className="px-4 py-3 text-xs text-red-400">{error}</p>}

        {!searching && searched && total === 0 && error === null && (
          <p className="px-4 py-6 text-center text-xs text-app-muted">没有找到「{query.trim()}」</p>
        )}

        {!searched && (
          <p className="px-4 py-6 text-center text-xs text-app-muted">
            输入关键词，回车搜索全书
          </p>
        )}

        {shownGroups.map((group) => (
          <section
            key={`${group.label}-${group.items[0]?.cfi ?? ''}`}
            className="mt-2"
          >
            <h3 className="px-4 py-1 text-[11px] text-app-muted">{group.label || '未分章'}</h3>
            <ul>
              {group.items.map((item) => (
                <li key={item.cfi}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.cfi)}
                    className="w-full cursor-pointer px-4 py-2 text-left text-xs leading-5 text-app-fg transition hover:bg-app-hover"
                  >
                    <span className="line-clamp-3">
                      {item.excerpt.pre}
                      <mark className="rounded-sm bg-amber-400/30 px-0.5 text-app-fg">
                        {item.excerpt.match}
                      </mark>
                      {item.excerpt.post}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {!searching && total > visible && (
          <div className="px-4 pt-2">
            <button
              type="button"
              onClick={() => setVisible((v) => v + 200)}
              className="w-full cursor-pointer rounded border border-app-border px-3 py-1.5 text-xs text-app-muted hover:bg-app-hover"
            >
              显示更多（还有 {total - visible} 处）
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
