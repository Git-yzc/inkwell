import { useState } from 'react';

import type { TocItem } from '@/features/reader/engine/types';

interface Props {
  toc: TocItem[];
  currentHref?: string | null;
  onSelect: (item: TocItem) => void;
  onClose: () => void;
}

function TocNode({
  item,
  depth,
  onSelect,
}: {
  item: TocItem;
  depth: number;
  onSelect: (i: TocItem) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = item.subitems.length > 0;

  return (
    <li>
      <div className="flex items-start" style={{ paddingLeft: depth * 14 }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1.5 w-4 shrink-0 cursor-pointer text-[10px] text-neutral-500 hover:text-neutral-300"
            aria-label={expanded ? '折叠' : '展开'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="mt-1.5 w-4 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelect(item)}
          className="flex-1 cursor-pointer rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-800 hover:text-amber-100"
        >
          {item.label}
        </button>
      </div>

      {hasChildren && expanded && (
        <ul>
          {item.subitems.map((sub) => (
            <TocNode key={sub.id} item={sub} depth={depth + 1} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function TocPanel({ toc, onSelect, onClose }: Props) {
  return (
    <aside className="flex h-full w-80 flex-col border-r border-neutral-800 bg-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h2 className="text-sm text-neutral-200">目录</h2>
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
        {toc.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-neutral-600">这本书没有提供目录</p>
        ) : (
          <ul>
            {toc.map((item) => (
              <TocNode key={item.id} item={item} depth={0} onSelect={onSelect} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
