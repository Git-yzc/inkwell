import {
  type FlowMode,
  FONT_CHOICES,
  type RendererSettings,
  THEMES,
  type ThemeKey,
} from '@/features/reader/engine/types';

interface Props {
  settings: RendererSettings;
  onChange: (patch: Partial<RendererSettings>) => void;
  onReset: () => void;
  onClose: () => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="shrink-0 text-sm text-neutral-400">{label}</span>
      <div className="flex flex-1 justify-end">{children}</div>
    </div>
  );
}

const buttonBase = 'cursor-pointer rounded border px-2.5 py-1 text-xs transition select-none';

export default function SettingsPanel({ settings, onChange, onReset, onClose }: Props) {
  return (
    <aside className="flex h-full w-80 flex-col border-l border-neutral-800 bg-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h2 className="text-sm text-neutral-200">阅读设置</h2>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer px-1 text-neutral-500 hover:text-neutral-200"
          aria-label="关闭"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 divide-y divide-neutral-800/70 overflow-y-auto px-4">
        <Row label="字号">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={14}
              max={30}
              step={1}
              value={settings.fontSize}
              onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
              className="w-40 cursor-pointer accent-amber-200"
            />
            <span className="w-10 text-right text-xs text-neutral-500 tabular-nums">
              {settings.fontSize}px
            </span>
          </div>
        </Row>

        <Row label="行距">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1.2}
              max={2.4}
              step={0.05}
              value={settings.lineHeight}
              onChange={(e) => onChange({ lineHeight: Number(e.target.value) })}
              className="w-40 cursor-pointer accent-amber-200"
            />
            <span className="w-10 text-right text-xs text-neutral-500 tabular-nums">
              {settings.lineHeight.toFixed(2)}
            </span>
          </div>
        </Row>

        <Row label="页边距">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={120}
              step={4}
              value={settings.margin}
              onChange={(e) => onChange({ margin: Number(e.target.value) })}
              className="w-40 cursor-pointer accent-amber-200"
            />
            <span className="w-10 text-right text-xs text-neutral-500 tabular-nums">
              {settings.margin}
            </span>
          </div>
        </Row>

        <Row label="字体">
          <select
            value={settings.fontFamily}
            onChange={(e) => onChange({ fontFamily: e.target.value })}
            className="cursor-pointer rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs outline-none"
          >
            {FONT_CHOICES.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </Row>

        <Row label="主题">
          <div className="flex gap-2">
            {(Object.keys(THEMES) as ThemeKey[]).map((k) => {
              const t = THEMES[k];
              const active = settings.theme === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => onChange({ theme: k })}
                  className={`${buttonBase} ${active ? 'border-amber-200/70 text-amber-100' : 'border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}
                >
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle ring-1 ring-black/20"
                    style={{ background: t.bg }}
                  />
                  {t.name}
                </button>
              );
            })}
          </div>
        </Row>

        <Row label="翻页方式">
          <div className="flex gap-2">
            {(['paginated', 'scrolled'] as FlowMode[]).map((m) => {
              const active = settings.flow === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => onChange({ flow: m })}
                  className={`${buttonBase} ${active ? 'border-amber-200/70 text-amber-100' : 'border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}
                >
                  {m === 'paginated' ? '翻页' : '滚动'}
                </button>
              );
            })}
          </div>
        </Row>

        <Row label="分栏">
          <div className="flex gap-2">
            {[1, 2].map((n) => {
              const active = settings.maxColumnCount === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => onChange({ maxColumnCount: n })}
                  className={`${buttonBase} ${active ? 'border-amber-200/70 text-amber-100' : 'border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}
                >
                  {n === 1 ? '单栏' : '双栏'}
                </button>
              );
            })}
          </div>
        </Row>
      </div>

      <footer className="border-t border-neutral-800 p-4">
        <button
          type="button"
          onClick={onReset}
          className="w-full cursor-pointer rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800"
        >
          恢复默认
        </button>
      </footer>
    </aside>
  );
}
