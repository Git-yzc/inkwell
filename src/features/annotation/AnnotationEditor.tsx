import { useEffect, useRef, useState } from 'react';

import type { Annotation, HighlightColor } from '@/lib/api';
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_ORDER,
  type SelectionInfo,
  type ThemeKey,
  THEMES,
} from '@/features/reader/engine/types';

/** 浮层大致宽度，用来把它夹在正文容器内（避免贴边被裁掉）。 */
const PANEL_WIDTH = 236;

export type EditorTarget =
  | { mode: 'new'; selection: SelectionInfo; chapter: string | null }
  | { mode: 'edit'; annotation: Annotation };

interface Props {
  target: EditorTarget;
  theme: ThemeKey;
  /** 正文容器的宽度，用于把浮层夹在可视区内 */
  containerWidth: number;
  /** 正文容器在视口里的左上角，用来把视口坐标换算成容器内坐标 */
  containerRect: { left: number; top: number };
  busy: boolean;
  onSave: (patch: { color: HighlightColor | null; note: string | null }) => void;
  onDelete?: () => void;
  onCancel: () => void;
}

/**
 * 划词浮层 / 批注编辑面板。
 *
 * 新建时：点色块**一步**就是一条高亮（不带笔记）；要写笔记再点「笔记」展开输入框。
 * 编辑时：直接展开输入框，可以改色、改笔记、删除。
 */
export default function AnnotationEditor({
  target,
  theme,
  containerWidth,
  containerRect,
  busy,
  onSave,
  onDelete,
  onCancel,
}: Props) {
  const editing = target.mode === 'edit';
  const existing = editing ? target.annotation : null;

  const [showNote, setShowNote] = useState(editing);
  const [note, setNote] = useState(existing?.note ?? '');
  const [color, setColor] = useState<HighlightColor>(existing?.color ?? 'yellow');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 展开输入框时把焦点放进去，省一次点击
  useEffect(() => {
    if (showNote) textareaRef.current?.focus();
  }, [showNote]);

  const t = THEMES[theme];

  // ---- 定位：默认贴在选区上方，上方放不下就挪到下方 ----
  const sel = target.mode === 'new' ? target.selection : null;
  const anchorX = sel ? sel.rect.x - containerRect.left + sel.rect.width / 2 : containerWidth / 2;
  const anchorTop = sel ? sel.rect.y - containerRect.top : 0;
  const anchorBottom = sel ? anchorTop + sel.rect.height : 0;

  const left = Math.max(
    8,
    Math.min(anchorX - PANEL_WIDTH / 2, Math.max(8, containerWidth - PANEL_WIDTH - 8)),
  );
  // 选区的 rect 是视口坐标，转成容器内坐标后判断「上方还有没有位置」
  const top = anchorTop > 132 ? anchorTop - 12 : anchorBottom + 12;
  const placement = anchorTop > 132 ? 'above' : 'below';

  const excerpt = (editing ? (existing?.text ?? '') : (target.selection.text ?? '')).trim();

  return (
    <div
      className="absolute z-30 rounded-lg border border-neutral-700 bg-neutral-900/98 p-2.5 shadow-xl backdrop-blur"
      style={{
        left,
        width: PANEL_WIDTH,
        top,
        // above: 面板底边贴着选区上方；below: 顶边贴着选区下方
        transform: placement === 'above' ? 'translateY(-100%)' : undefined,
      }}
    >
      {excerpt && (
        <p
          className="mb-2 line-clamp-2 border-l-2 pl-2 text-[11px] leading-snug"
          style={{ borderColor: t.muted, color: t.muted }}
        >
          {excerpt}
        </p>
      )}

      <div className="flex items-center gap-1.5">
        {HIGHLIGHT_COLOR_ORDER.map((name) => (
          <button
            key={name}
            type="button"
            aria-label={`高亮为 ${name}`}
            disabled={busy}
            onClick={() => {
              setColor(name);
              // 编辑模式下点色块只改色，笔记保持原样由「保存」提交
              if (editing) return;
              onSave({ color: name, note: null });
            }}
            className="h-7 w-7 cursor-pointer rounded-full ring-2 transition disabled:opacity-40"
            style={{
              background: HIGHLIGHT_COLORS[name],
              // 选中态用白色描边，未选中用半透明黑，深浅底色上都看得清
              boxShadow: color === name ? '0 0 0 2px #fafafa' : '0 0 0 2px rgba(0,0,0,.35)',
            }}
          />
        ))}

        <div className="ml-auto flex items-center gap-1">
          {!editing && (
            <button
              type="button"
              onClick={() => setShowNote((v) => !v)}
              className="cursor-pointer rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              笔记
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            aria-label="关闭"
            className="cursor-pointer rounded px-1.5 py-1 text-xs text-neutral-500 hover:text-neutral-200"
          >
            ✕
          </button>
        </div>
      </div>

      {showNote && (
        <div className="mt-2">
          <textarea
            ref={textareaRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="写点想法…"
            className="w-full resize-none rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-amber-200/50"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onSave({ color, note: note.trim() || null })}
              className="cursor-pointer rounded bg-amber-200/90 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-amber-100 disabled:opacity-50"
            >
              保存
            </button>
            {editing && onDelete && (
              <button
                type="button"
                disabled={busy}
                onClick={onDelete}
                className="cursor-pointer rounded border border-red-900/60 px-2.5 py-1 text-xs text-red-300 hover:bg-red-950/60 disabled:opacity-50"
              >
                删除
              </button>
            )}
            <span className="ml-auto text-[10px] text-neutral-600">
              {editing ? '改完点保存' : '留空即纯高亮'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
