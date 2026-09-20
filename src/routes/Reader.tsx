import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AnnotationEditor, { type EditorTarget } from '@/features/annotation/AnnotationEditor';
import AnnotationPanel from '@/features/annotation/AnnotationPanel';
import { ReaderEngine } from '@/features/reader/engine';
import {
  type BookInfo,
  type HighlightView,
  type RendererSettings,
  THEMES,
  type TocItem,
} from '@/features/reader/engine/types';
import SettingsPanel from '@/features/reader/SettingsPanel';
import TocPanel from '@/features/reader/TocPanel';
import {
  type Annotation,
  api,
  type Book,
  type ExportFormat,
  type HighlightColor,
  readableError,
} from '@/lib/api';
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
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [chapter, setChapter] = useState<string | null>(null);
  const [barVisible, setBarVisible] = useState(true);

  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  /**
   * 当前页的 CFI。
   *
   * 和 lastLocRef 存的是同一件事，但用途不同：ref 给「只注册一次的引擎监听器」
   * 读最新值，state 给渲染用（书签按钮要跟着翻页变色）。
   * 反正每次 relocate 本来就会 setFraction 触发重渲染，多这一个 state 不额外花钱。
   */
  const [currentCfi, setCurrentCfi] = useState<string | null>(null);
  /** 划词浮层 / 批注编辑面板；null 表示不显示 */
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** 正文容器的尺寸与位置，用来把选区坐标换算成容器内坐标 */
  const [hostBox, setHostBox] = useState({ left: 0, top: 0, width: 0 });

  const theme = THEMES[settings.theme];

  /**
   * 最近一次 relocate 的结果。
   *
   * 放 ref 不放 state：翻页时它每页都变，进 state 会让整页重渲染；
   * 只有「加书签」这种点击时才需要读它。
   */
  /**
   * 批注列表的 ref 镜像。
   *
   * 引擎的点击回调只注册一次，闭包里的 annotations 会永远是初始值；
   * 之前靠 setAnnotations 的函数式更新「顺手」读最新值，但那是在更新函数里做副作用，
   * React 严格模式下会重复执行 —— 读 ref 才是正经做法。
   */
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;

  const lastLocRef = useRef<{ cfi: string | null; chapter: string | null }>({
    cfi: null,
    chapter: null,
  });

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
      setCurrentCfi(loc.cfi);
      lastLocRef.current = { cfi: loc.cfi, chapter: loc.chapterLabel };

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

    // 划词 → 弹浮层
    const offSelection = engine.onSelection((sel) => {
      if (!sel) return;
      setEditor({
        mode: 'new',
        selection: sel,
        chapter: lastLocRef.current.chapter,
      });
    });

    // 点中已有高亮 → 打开编辑
    const offAnnotationClick = engine.onAnnotationClick((cfi) => {
      const hit = annotationsRef.current.find((a) => a.cfi === cfi && a.type === 'highlight');
      if (hit) setEditor({ mode: 'edit', annotation: hit });
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
      offSelection();
      offAnnotationClick();
      engine.close();
      engineRef.current = null;
    };
  }, [book]);

  // ---- 载入这本书的批注 ----
  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    void api
      .listAnnotations(book.id)
      .then((list) => {
        if (!cancelled) setAnnotations(list);
      })
      .catch((e) => {
        // 批注读不出来不该挡住读书，只在控制台留痕
        console.error('读取批注失败', e);
      });
    return () => {
      cancelled = true;
    };
  }, [book]);

  // ---- 批注变化时同步给渲染引擎（引擎只画高亮，书签不用画）----
  useEffect(() => {
    const highlights: HighlightView[] = annotations
      .filter((a) => a.type === 'highlight')
      .map((a) => ({ cfi: a.cfi, color: a.color }));
    engineRef.current?.setHighlights(highlights);
  }, [annotations]);

  // ---- 量一下正文容器的位置：选区的视口坐标要减掉它才能定位浮层 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const r = host.getBoundingClientRect();
      setHostBox({ left: r.left, top: r.top, width: r.width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
    // hostRef 挂的 div 一直存在，尺寸变化由 ResizeObserver 兜住，不需要别的依赖
  }, []);

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

  /** 当前页有没有书签。 */
  const bookmarkHere =
    currentCfi !== null && annotations.some((a) => a.type === 'bookmark' && a.cfi === currentCfi);

  function handleTocSelect(item: TocItem) {
    setShowToc(false);
    if (item.href) void engineRef.current?.goTo(item.href);
  }

  /* ---------------------------------------------------------------- 批注 */

  /** 新增一条高亮。cfi / 原文都来自选区，章节取当前章。 */
  const createHighlight = useCallback(
    async (
      cfi: string,
      text: string,
      chapter: string | null,
      color: HighlightColor,
      note: string | null,
    ) => {
      if (!book) return;
      setAnnotationBusy(true);
      try {
        const created = await api.addAnnotation({
          bookId: book.id,
          kind: 'highlight',
          cfi,
          text,
          chapter,
          color,
          note,
        });
        setAnnotations((list) => [created, ...list]);
        engineRef.current?.clearSelection();
        setEditor(null);
      } catch (e) {
        setError(`添加高亮失败：${readableError(e)}`);
      } finally {
        setAnnotationBusy(false);
      }
    },
    [book],
  );

  async function handleEditorSave(patch: { color: HighlightColor | null; note: string | null }) {
    if (!editor) return;

    if (editor.mode === 'new') {
      await createHighlight(
        editor.selection.cfi,
        editor.selection.text,
        editor.chapter,
        patch.color ?? 'yellow',
        patch.note,
      );
      return;
    }

    setAnnotationBusy(true);
    try {
      await api.updateAnnotation(editor.annotation.id, patch.note, patch.color);
      setAnnotations((list) =>
        list.map((a) =>
          a.id === editor.annotation.id ? { ...a, note: patch.note, color: patch.color } : a,
        ),
      );
      setEditor(null);
    } catch (e) {
      setError(`保存批注失败：${readableError(e)}`);
    } finally {
      setAnnotationBusy(false);
    }
  }

  async function handleAnnotationDelete(target: Annotation) {
    setAnnotationBusy(true);
    try {
      await api.deleteAnnotation(target.id);
      setAnnotations((list) => list.filter((a) => a.id !== target.id));
      setEditor(null);
    } catch (e) {
      setError(`删除批注失败：${readableError(e)}`);
    } finally {
      setAnnotationBusy(false);
    }
  }

  /** 加/去当前页的书签。 */
  async function toggleBookmark() {
    if (!book) return;
    const { cfi, chapter: ch } = lastLocRef.current;
    if (!cfi) return;

    const existing = annotations.find((a) => a.type === 'bookmark' && a.cfi === cfi);
    if (existing) {
      await handleAnnotationDelete(existing);
      return;
    }

    try {
      const created = await api.addAnnotation({
        bookId: book.id,
        kind: 'bookmark',
        cfi,
        chapter: ch,
      });
      setAnnotations((list) => [created, ...list]);
    } catch (e) {
      setError(`添加书签失败：${readableError(e)}`);
    }
  }

  function handleAnnotationJump(a: Annotation) {
    setShowAnnotations(false);
    setEditor(null);
    void engineRef.current?.goTo(a.cfi);
  }

  /** 导出。写文件在 Rust 侧做 —— 前端没有任意路径的 fs 权限，Android 上更拿不到。 */
  async function handleExport(format: ExportFormat) {
    if (!book) return;
    const ext = format === 'json' ? 'json' : 'md';
    const target = await saveDialog({
      title: '导出批注',
      defaultPath: `${book.title} · 批注.${ext}`,
      filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [ext] }],
    });
    if (!target) return;

    setExporting(true);
    try {
      const count = await api.exportAnnotations(book.id, target, format);
      setError(null);
      window.alert(`已导出 ${count} 条批注到：\n${target}`);
    } catch (e) {
      setError(`导出失败：${readableError(e)}`);
    } finally {
      setExporting(false);
    }
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
          onClick={() => void toggleBookmark()}
          aria-label={bookmarkHere ? '去掉书签' : '加书签'}
          title={bookmarkHere ? '去掉书签' : '加书签'}
          className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-black/5"
          style={{ color: bookmarkHere ? '#e0b64a' : theme.muted }}
        >
          {bookmarkHere ? '★' : '☆'}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowToc((v) => !v);
            setShowSettings(false);
            setShowAnnotations(false);
          }}
          className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-black/5"
          style={{ color: theme.muted }}
        >
          目录
        </button>
        <button
          type="button"
          onClick={() => {
            setShowAnnotations((v) => !v);
            setShowToc(false);
            setShowSettings(false);
          }}
          className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-black/5"
          style={{ color: showAnnotations ? '#e0b64a' : theme.muted }}
        >
          批注{annotations.length > 0 ? ` ${annotations.length}` : ''}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowSettings((v) => !v);
            setShowToc(false);
            setShowAnnotations(false);
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

        {/* 划词浮层 / 批注编辑。放在正文之上、点按区之下 */}
        {editor !== null && (
          <AnnotationEditor
            target={editor}
            theme={settings.theme}
            containerWidth={hostBox.width}
            containerRect={{ left: hostBox.left, top: hostBox.top }}
            busy={annotationBusy}
            onSave={(patch) => void handleEditorSave(patch)}
            onDelete={
              editor.mode === 'edit'
                ? () => void handleAnnotationDelete(editor.annotation)
                : undefined
            }
            onCancel={() => {
              engineRef.current?.clearSelection();
              setEditor(null);
            }}
          />
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
      {showAnnotations && (
        <div className="absolute inset-y-0 right-0 z-30" style={{ top: 48 }}>
          <AnnotationPanel
            annotations={annotations}
            exporting={exporting}
            onJump={handleAnnotationJump}
            onDelete={(a) => void handleAnnotationDelete(a)}
            onExport={(fmt) => void handleExport(fmt)}
            onClose={() => setShowAnnotations(false)}
          />
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
