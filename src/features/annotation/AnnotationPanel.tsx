import type { Annotation, ExportFormat } from '@/lib/api';
import { HIGHLIGHT_COLORS, type HighlightColorName } from '@/features/reader/engine/types';
import { formatRelative } from '@/lib/util';

interface Props {
  annotations: Annotation[];
  /** 正在导出时禁用按钮，避免连点 */
  exporting: boolean;
  onJump: (a: Annotation) => void;
  onDelete: (a: Annotation) => void;
  onExport: (format: ExportFormat) => void;
  onClose: () => void;
}

/** 一条批注在列表里的样子：高亮显示色块 + 原文 + 笔记；书签只有一行。 */
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
        className="w-full cursor-pointer rounded px-2 py-2 pr-7 text-left transition hover:bg-neutral-800"
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
              <p className="text-xs text-neutral-400">书签 · {item.chapter || '未分章'}</p>
            ) : (
              <p className="line-clamp-3 text-xs leading-5 text-neutral-200">{item.text}</p>
            )}
            {item.note && (
              <p className="mt-1 line-clamp-3 border-l-2 border-amber-200/40 pl-2 text-[11px] leading-snug text-neutral-400">
                {item.note}
              </p>
            )}
            <p className="mt-1 truncate text-[10px] text-neutral-600">
              {item.chapter || '未分章'} · {formatRelative(item.createdAt)}
            </p>
          </div>
        </div>
      </button>

      <button
        type="button"
        aria-label="删除这条批注"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(item);
        }}
        // ⚠️ pointer-coarse 不能省：安卓上没有 hover，只写 group-hover 的话
        // 触摸设备永远看不到删除按钮（书库卡片也踩过同样的坑）。
        className="absolute top-1.5 right-1.5 hidden cursor-pointer rounded px-1.5 text-xs text-neutral-500 hover:text-red-300 group-hover:block pointer-coarse:block"
      >
        ✕
      </button>
    </li>
  );
}

export default function AnnotationPanel({
  annotations,
  exporting,
  onJump,
  onDelete,
  onExport,
  onClose,
}: Props) {
  const highlights = annotations.filter((a) => a.type === 'highlight').length;
  const bookmarks = annotations.length - highlights;

  return (
    <aside className="flex h-full w-80 flex-col border-l border-neutral-800 bg-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm text-neutral-200">批注</h2>
          {annotations.length > 0 && (
            <span className="text-[10px] text-neutral-500">
              {highlights} 条高亮 · {bookmarks} 个书签
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer px-1 text-neutral-500 hover:text-neutral-200"
          aria-label="关闭"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto py-2">
        {annotations.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-neutral-600">
            还没有批注。
            <br />
            选中正文即可高亮，点顶栏的 ☆ 加书签。
          </p>
        ) : (
          <ul className="px-2">
            {annotations.map((a) => (
              <Row key={a.id} item={a} onJump={onJump} onDelete={onDelete} />
            ))}
          </ul>
        )}
      </div>

      <footer className="flex gap-2 border-t border-neutral-800 p-3">
        <button
          type="button"
          disabled={exporting || annotations.length === 0}
          onClick={() => onExport('markdown')}
          className="flex-1 cursor-pointer rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
        >
          {exporting ? '导出中…' : '导出 Markdown'}
        </button>
        <button
          type="button"
          disabled={exporting || annotations.length === 0}
          onClick={() => onExport('json')}
          className="flex-1 cursor-pointer rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
        >
          导出 JSON
        </button>
      </footer>
    </aside>
  );
}
