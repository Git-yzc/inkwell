import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ReaderEngine } from '@/features/reader/engine';
import {
  type BookInfo,
  type RendererSettings,
  THEMES,
  type TocItem,
} from '@/features/reader/engine/types';
import SettingsPanel from '@/features/reader/SettingsPanel';
import TocPanel from '@/features/reader/TocPanel';
import { api, type Book, readableError } from '@/lib/api';
import { formatPercent } from '@/lib/util';
import { useReaderSettings } from '@/store/reader-settings';

/** 进度写库的节流间隔：翻页很频繁，没必要每页都打一次数据库。 */
const PROGRESS_SAVE_MS = 1200;

export default function Reader() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const settings = useReaderSettings((s) => s.settings);
  const updateSettings = useReaderSettings((s) => s.update);
  const resetSettings = useReaderSettings((s) => s.reset);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ReaderEngine | null>(null);
  /**
   * 用 ref 暂存最新的设置对象，供引擎初始化时读取。
   * 不放进 effect 依赖：调设置不应该重建引擎（会丢阅读位置）。
   */
  const settingsRef = useRef<RendererSettings>(settings);
  settingsRef.current = settings;

  const [book, setBook] = useState<Book | null>(null);
  const [info, setInfo] = useState<BookInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showToc, setShowToc] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [chapter, setChapter] = useState<string | null>(null);
  const [barVisible, setBarVisible] = useState(true);

  const theme = THEMES[settings.theme];

  // ---- 载入书籍 ----
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const b = await api.getBook(id);
        if (cancelled) return;
        if (!b) {
          setError('这本书不在书库里');
          setLoading(false);
          return;
        }
        setBook(b);
        setFraction(b.progressPct);
        await api.touchBook(b.id);
      } catch (e) {
        if (!cancelled) {
          setError(readableError(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  // ---- 启动引擎（每本书只做一次）----
  useEffect(() => {
    const host = hostRef.current;
    if (!book || !host) return;

    let disposed = false;
    const engine = new ReaderEngine(host, settingsRef.current);
    engineRef.current = engine;

    let saveTimer: number | undefined;
    let lastSavedCfi: string | null = null;

    const offRelocate = engine.onRelocate((loc) => {
      setFraction(loc.fraction);
      setChapter(loc.chapterLabel);

      // 节流写库：位置变化先攒着，停止翻页一会儿后再落库
      if (loc.cfi !== null && loc.cfi !== lastSavedCfi) {
        window.clearTimeout(saveTimer);
        const cfi = loc.cfi;
        saveTimer = window.setTimeout(() => {
          lastSavedCfi = cfi;
          void api.saveProgress(book.id, cfi, loc.fraction).catch(() => {
            // 进度保存失败不打断阅读，下次翻页会再试
          });
        }, PROGRESS_SAVE_MS);
      }
    });

    (async () => {
      try {
        const bookInfo = await engine.open(book.absPath, { lastLocation: book.progressCfi });
        if (disposed) return;
        setInfo(bookInfo);
        setLoading(false);
      } catch (e) {
        if (!disposed) {
          setError(`打开失败：${readableError(e)}`);
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      window.clearTimeout(saveTimer);
      offRelocate();
      engine.close();
      engineRef.current = null;
    };
  }, [book]);

  // ---- 设置变化时实时套用（不重建引擎）----
  useEffect(() => {
    engineRef.current?.applySettings(settings);
  }, [settings]);

  // ---- 键盘翻页 ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const engine = engineRef.current;
      if (!engine) return;
      // 方向键翻页在滚动模式下会与浏览器滚动冲突，交给内核处理更稳
      switch (e.key) {
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          void engine.prev();
          break;
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault();
          void engine.next();
          break;
        case 'Escape':
          if (showToc || showSettings) {
            setShowToc(false);
            setShowSettings(false);
          } else {
            navigate('/');
          }
          break;
        default:
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, showToc, showSettings]);

  /**
   * 顶部/底部栏在无操作几秒后自动隐藏，把屏幕让给正文。
   *
   * 计时器直接放在活动处理器内部：任何一次指针移动、点按或按键都
   * 「显示 + 重新计时」。这样不必用额外的状态去触发 effect 重跑，
   * 逻辑也更贴近它想表达的意思。
   */
  useEffect(() => {
    let timer: number | undefined;

    const bump = () => {
      setBarVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBarVisible(false), 4000);
    };

    bump(); // 刚进入时也启动计时

    window.addEventListener('pointermove', bump);
    window.addEventListener('pointerdown', bump);
    window.addEventListener('keydown', bump);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', bump);
      window.removeEventListener('pointerdown', bump);
      window.removeEventListener('keydown', bump);
    };
  }, []);

  const toc = useMemo(() => info?.toc ?? [], [info]);

  function handleTocSelect(item: TocItem) {
    setShowToc(false);
    if (item.href) void engineRef.current?.goTo(item.href);
  }

  return (
    <div
      className="flex h-screen flex-col overflow-hidden"
      style={{ background: theme.bg, color: theme.fg }}
    >
      {/* 顶栏 */}
      <header
        className="z-20 flex shrink-0 items-center gap-3 border-b px-4 transition-opacity duration-300"
        style={{
          height: 48,
          borderColor: `${theme.muted}33`,
          opacity: barVisible ? 1 : 0,
          pointerEvents: barVisible ? 'auto' : 'none',
          background: theme.bg,
        }}
      >
        <button
          type="button"
          onClick={() => navigate('/')}
          className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-black/5"
          style={{ color: theme.muted }}
        >
          ← 书库
        </button>

        <div className="min-w-0 flex-1 truncate text-sm">
          {book?.title ?? ''}
          {chapter !== null && (
            <span className="ml-2 text-xs" style={{ color: theme.muted }}>
              {chapter}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            setShowToc((v) => !v);
            setShowSettings(false);
          }}
          className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-black/5"
          style={{ color: theme.muted }}
        >
          目录
        </button>
        <button
          type="button"
          onClick={() => {
            setShowSettings((v) => !v);
            setShowToc(false);
          }}
          className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-black/5"
          style={{ color: theme.muted }}
        >
          设置
        </button>
      </header>

      {/* 正文区 */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full w-full" />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm" style={{ color: theme.muted }}>
              正在打开…
            </p>
          </div>
        )}

        {error !== null && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
            <p className="text-sm text-red-500">{error}</p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="cursor-pointer rounded border px-3 py-1.5 text-sm"
              style={{ borderColor: `${theme.muted}66`, color: theme.muted }}
            >
              返回书库
            </button>
          </div>
        )}

        {/* 左右点按翻页。放在正文之上但避开面板区域 */}
        {!loading && error === null && (
          <>
            <button
              type="button"
              aria-label="上一页"
              onClick={() => void engineRef.current?.prev()}
              className="absolute top-0 bottom-12 left-0 w-[18%] cursor-w-resize"
            />
            <button
              type="button"
              aria-label="下一页"
              onClick={() => void engineRef.current?.next()}
              className="absolute top-0 right-0 bottom-12 w-[18%] cursor-e-resize"
            />
          </>
        )}
      </div>

      {/* 底栏进度 */}
      <footer
        className="z-20 flex shrink-0 items-center gap-3 px-4 transition-opacity duration-300"
        style={{
          height: 44,
          opacity: barVisible ? 1 : 0,
          pointerEvents: barVisible ? 'auto' : 'none',
          background: theme.bg,
        }}
      >
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(fraction * 1000)}
          onChange={(e) => {
            const f = Number(e.target.value) / 1000;
            setFraction(f);
            void engineRef.current?.goToFraction(f);
          }}
          className="flex-1 cursor-pointer accent-amber-500"
        />
        <span className="w-12 text-right text-xs tabular-nums" style={{ color: theme.muted }}>
          {formatPercent(fraction)}
        </span>
      </footer>

      {/* 侧栏 */}
      {showToc && (
        <div className="absolute inset-y-0 left-0 z-30" style={{ top: 48 }}>
          <TocPanel toc={toc} onSelect={handleTocSelect} onClose={() => setShowToc(false)} />
        </div>
      )}
      {showSettings && (
        <div className="absolute inset-y-0 right-0 z-30" style={{ top: 48 }}>
          <SettingsPanel
            settings={settings}
            onChange={updateSettings}
            onReset={resetSettings}
            onClose={() => setShowSettings(false)}
          />
        </div>
      )}
    </div>
  );
}
