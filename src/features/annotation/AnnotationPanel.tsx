import { HIGHLIGHT_COLORS, type HighlightColorName } from '@/features/reader/engine/types';
import type { Annotation, ExportFormat } from '@/lib/api';
import { formatRelative } from '@/lib/util';

/**
 * 侧栏的两个列表。
 *
 * 书签与批注在库里仍是同一张 `annotations` 表、靠 `type` 区分（不拆表，
 * 见 docs/REQUIREMENTS-2026-10-11-bookmark-indicator.md 的 B13），但界面上**分成两个独立列表**：
 * 各自计数、空状态、删除与跳转。
 */
export type AnnotationTab = 'highlight' | 'bookmark';

interface Props {
  annotations: Annotation[];
  /** 当前显示哪一个列表 */
  tab: AnnotationTab;
  onTabChange: (tab: AnnotationTab) => void;
  /** 正在导出时禁用按钮，避免连点 */
  exporting: boolean;
  onJump: (a: Annotation) => void;
  onDelete: (a: Annotation) => void;
  onExport: (format: ExportFormat) => void;
  onClose: () => void;
}

const TABS: { value: AnnotationTab; label: string }[] = [
  { value: 'highlight', label: '批注' },
  { value: 'bookmark', label: '书签' },
];

/** 一条记录在列表里的样子：高亮显示色块 + 原文 + 笔记；书签只有一行。 */
function Row({
  item,
  onJump,
  onDelete,
}: {
  item: Annotation;
  onJump: (a: Annotation) => void;
  onDelete: (a: Annotation) => void;
}) {
  const isBookmark = item.type === 'bookmark';
  const swatch = isBookmark
    ? '🔖'
    : (HIGHLIGHT_COLORS[(item.color ?? 'yellow') as HighlightColorName] ?? HIGHLIGHT_COLORS.yellow);

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onJump(item)}
        className="w-full cursor-pointer rounded px-2 py-2 pr-7 text-left transition hover:bg-app-hover"
      >
        <div className="flex gap-2">
          {isBookmark ? (
            <span className="mt-0.5 shrink-0 text-xs leading-5">{swatch}</span>
          ) : (
            <span
              className="mt-1 h-3.5 w-3.5 shrink-0 rounded-sm ring-1 ring-black/30"
              style={{ background: swatch }}
            />
          )}
          <div className="min-w-0 flex-1">
            {isBookmark ? (
              <p className="text-xs text-app-muted">书签 · {item.chapter || '未分章'}</p>
            ) : (
              <p className="line-clamp-3 text-xs leading-5 text-app-fg">{item.text}</p>
            )}
            {item.note && (
              <p className="mt-1 line-clamp-3 border-l-2 border-amber-500/50 pl-2 text-[11px] leading-snug text-app-muted">
                {item.note}
              </p>
            )}
            <p className="mt-1 truncate text-[10px] text-app-muted">
              {item.chapter || '未分章'} · {formatRelative(item.createdAt)}
            </p>
          </div>
        </div>
      </button>

      <button
        type="button"
        aria-label={isBookmark ? '删除这个书签' : '删除这条批注'}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(item);
        }}
        // ⚠️ pointer-coarse 不能省：安卓上没有 hover，只写 group-hover 的话
        // 触摸设备永远看不到删除按钮（书库卡片也踩过同样的坑）。
        className="absolute top-1.5 right-1.5 hidden cursor-pointer rounded px-1.5 text-xs text-app-muted hover:text-red-400 group-hover:block pointer-coarse:block"
      >
        ✕
      </button>
    </li>
  );
}

export default function AnnotationPanel({
  annotations,
  tab,
  onTabChange,
  exporting,
  onJump,
  onDelete,
  onExport,
  onClose,
}: Props) {
  // 书签与批注分开成两个列表（REQ-2026-10-11-07）：数据同表，界面分开。
  const highlights = annotations.filter((a) => a.type === 'highlight');
  const bookmarks = annotations.filter((a) => a.type === 'bookmark');
  const list = tab === 'bookmark' ? bookmarks : highlights;
  const countOf: Record<AnnotationTab, number> = {
    highlight: highlights.length,
    bookmark: bookmarks.length,
  };

  return (
    <aside className="flex h-full w-80 flex-col border-l border-app-border bg-app-surface">
      <header className="flex items-center justify-between gap-2 border-b border-app-border px-3 py-2.5">
        <div className="flex items-center gap-1" role="tablist" aria-label="批注与书签">
          {TABS.map((t) => {
            const active = t.value === tab;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTabChange(t.value)}
                className={
                  'cursor-pointer rounded px-2.5 py-1 text-xs transition ' +
                  (active ? 'bg-app-hover text-app-accent' : 'text-app-muted hover:text-app-fg')
                }
              >
                {t.label}
                {countOf[t.value] > 0 && (
                  <span className="ml-1 tabular-nums opacity-70">{countOf[t.value]}</span>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer px-1 text-app-muted hover:text-app-fg"
          aria-label="关闭"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto py-2">
        {list.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-app-muted">
            {tab === 'bookmark' ? (
              <>
                还没有书签。
                <br />
                翻页模式下下拉，或点顶栏的 ☆ 添加。
              </>
            ) : (
              <>
                还没有批注。
                <br />
                选中正文即可高亮。
              </>
            )}
          </p>
        ) : (
          <ul className="px-2">
            {list.map((a) => (
              <Row key={a.id} item={a} onJump={onJump} onDelete={onDelete} />
            ))}
          </ul>
        )}
      </div>

      <footer className="flex gap-2 border-t border-app-border p-3">
        <button
          type="button"
          disabled={exporting || annotations.length === 0}
          onClick={() => onExport('markdown')}
          className="flex-1 cursor-pointer rounded border border-app-border px-3 py-1.5 text-xs text-app-fg hover:bg-app-hover disabled:opacity-40"
        >
          {exporting ? '导出中…' : '导出 Markdown'}
        </button>
        <button
          type="button"
          disabled={exporting || annotations.length === 0}
          onClick={() => onExport('json')}
          className="flex-1 cursor-pointer rounded border border-app-border px-3 py-1.5 text-xs text-app-fg hover:bg-app-hover disabled:opacity-40"
        >
          导出 JSON
        </button>
      </footer>
    </aside>
  );
}
