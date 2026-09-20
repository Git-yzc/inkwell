import { useEffect, useRef, useState } from 'react';

import type { Annotation, HighlightColor } from '@/lib/api';
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_ORDER,
  type SelectionInfo,
  type ThemeKey,
  THEMES,
} from '@/features/reader/engine/types';

export type EditorTarget =
  | { mode: 'new'; selection: SelectionInfo; chapter: string | null }
  | { mode: 'edit'; annotation: Annotation };

interface Props {
  target: EditorTarget;
  theme: ThemeKey;
  busy: boolean;
  onSave: (patch: { color: HighlightColor | null; note: string | null }) => void;
  onDelete?: () => void;
  onCancel: () => void;
}

/**
 * 划词后的批注操作栏 / 批注编辑面板。
 *
 * ⚠️ **刻意做成贴着屏幕底部的横条，而不是浮在选区旁边。**
 * Android 上选中文字会先弹出系统自己的「复制 / 粘贴 / 网络搜索」浮层，
 * 那是**原生浮层**、永远贴着选区、且画在 WebView 之上 —— 我们浮在选区旁边的
 * 任何东西都会被它盖住（真机实测）。底部横条离选区远，两边互不干扰。
 *
 * 新建时：点色块**一步**就是一条高亮（不带笔记）；要写笔记再点「笔记」展开输入框。
 * 编辑时：直接展开输入框，可以改色、改笔记、删除。
 */
export default function AnnotationEditor({
  target,
  theme,
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
  const excerpt = (editing ? (existing?.text ?? '') : target.selection.text).trim();

  return (
    <div className="border-t border-neutral-700 bg-neutral-900/98 shadow-[0_-8px_24px_rgba(0,0,0,.35)] backdrop-blur">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <p
            className="line-clamp-1 min-w-0 flex-1 border-l-2 pl-2 text-[11px] leading-5"
            style={{ borderColor: t.muted, color: t.muted }}
          >
            {excerpt || '（书签）'}
          </p>
          <button
            type="button"
            onClick={onCancel}
            aria-label="关闭"
            className="-mt-0.5 shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:text-neutral-200"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2">
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
                className="h-8 w-8 cursor-pointer rounded-full ring-2 transition disabled:opacity-40"
                style={{
                  background: HIGHLIGHT_COLORS[name],
                  // 选中态用白色描边，未选中用半透明黑，深浅底色上都看得清
                  boxShadow: color === name ? '0 0 0 2px #fafafa' : '0 0 0 2px rgba(0,0,0,.35)',
                }}
              />
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {!editing && (
              <button
                type="button"
                onClick={() => setShowNote((v) => !v)}
                className="cursor-pointer rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
              >
                {showNote ? '收起笔记' : '笔记'}
              </button>
            )}
            {editing && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSave({ color, note: note.trim() || null })}
                  className="cursor-pointer rounded bg-amber-200/90 px-3.5 py-1.5 text-xs font-medium text-neutral-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  保存
                </button>
                {onDelete && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onDelete}
                    className="cursor-pointer rounded border border-red-900/60 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/60 disabled:opacity-50"
                  >
                    删除
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {showNote && (
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="写点想法…（留空即纯高亮）"
              className="min-w-0 flex-1 resize-none rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-amber-200/50"
            />
            {!editing && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onSave({ color, note: note.trim() || null })}
                className="shrink-0 cursor-pointer rounded bg-amber-200/90 px-3.5 py-2 text-xs font-medium text-neutral-900 hover:bg-amber-100 disabled:opacity-50"
              >
                保存
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
