import { convertFileSrc } from '@tauri-apps/api/core';
import { useState } from 'react';

import type { Book } from '@/lib/api';
import { formatPercent } from '@/lib/util';

interface Props {
  book: Book;
  onOpen: (book: Book) => void;
  onDelete: (book: Book) => void;
}

/** 封面缺失或图片加载失败时显示的占位：书名首字 + 一个稳定的配色。 */
function CoverFallback({ title }: { title: string }) {
  const ch = title.trim().charAt(0) || '书';
  // 用书名做哈希挑一个色相，让每本书的占位色稳定且有区分度
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{ background: `hsl(${h} 28% 22%)` }}
    >
      <span className="font-serif text-5xl text-neutral-200/85">{ch}</span>
    </div>
  );
}

export default function BookCard({ book, onOpen, onDelete }: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = book.coverAbsPath !== null && !imgFailed;

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onOpen(book)}
        className="block w-full cursor-pointer text-left"
        title={book.title}
      >
        <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-neutral-800 shadow-lg ring-1 ring-neutral-700/60 transition group-hover:ring-amber-200/40">
          {showImage ? (
            <img
              src={convertFileSrc(book.coverAbsPath as string)}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <CoverFallback title={book.title} />
          )}

          {book.finished && (
            <span className="absolute top-2 right-2 rounded bg-emerald-900/85 px-1.5 py-0.5 text-[10px] text-emerald-100">
              读完
            </span>
          )}

          {book.progressPct > 0 && !book.finished && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/45">
              <div
                className="h-full bg-amber-300/85"
                style={{ width: `${Math.round(book.progressPct * 100)}%` }}
              />
            </div>
          )}
        </div>

        <div className="mt-2 px-0.5">
          <p className="truncate text-sm text-neutral-100">{book.title}</p>
          <p className="mt-0.5 truncate text-xs text-neutral-500">
            {book.author ?? '未知作者'}
            {book.progressPct > 0 && !book.finished && (
              <span className="ml-1.5 text-amber-200/70">{formatPercent(book.progressPct)}</span>
            )}
          </p>
        </div>
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(book);
        }}
        aria-label="删除"
        className="absolute top-2 left-2 hidden h-7 w-7 cursor-pointer items-center justify-center rounded bg-black/70 text-neutral-300 transition hover:bg-red-900/90 hover:text-red-100 group-hover:flex"
      >
        ✕
      </button>
    </div>
  );
}
