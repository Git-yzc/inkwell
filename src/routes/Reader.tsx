import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AppThemeToggle from '@/components/AppThemeToggle';
import AnnotationEditor, { type EditorTarget } from '@/features/annotation/AnnotationEditor';
import AnnotationPanel, { type AnnotationTab } from '@/features/annotation/AnnotationPanel';
import { PULL_TRIGGER_PX, ReaderEngine } from '@/features/reader/engine';
import {
  BOOKMARK_COLORS,
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
  type AnnotationLayout,
  api,
  type Book,
  type ExportFormat,
  type HighlightColor,
  readableError,
} from '@/lib/api';
import { toJpegBytes } from '@/lib/image';
import { formatPercent, isAndroid } from '@/lib/util';
import { useReaderSettings } from '@/store/reader-settings';

/** 进度写库的节流间隔：翻页很频繁，没必要每页都打一次数据库。 */
const PROGRESS_SAVE_MS = 1200;

/** 工具栏无操作多久后自动隐藏（毫秒）。 */
const BAR_HIDE_MS = 4000;

/**
 * 「翻页动效掉帧」提示是否已经弹过。
 *
 * 按 Q9 / D4 定案：**每次切到「翻纸」只提醒一次**，之后不再打扰；标记跨重启保留，
 * 只有翻纸「关 → 开」才重置（所以写 localStorage，不是内存态）。
 */
const PAGE_TURN_WARN_KEY = 'inkwell.reader.pageTurnWarned';

/**
 * 页上书签缎带离正文区右边缘的距离（px）。
 *
 * 贴在最右边会显得像贴在窗口上、而不是贴在书页上，所以留一点内缩。
 */
const RIBBON_INSET_PX = 14;

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
  /** 侧栏显示哪个列表：批注（高亮/笔记）还是书签（REQ-2026-10-11-07 拆分） */
  const [annotationTab, setAnnotationTab] = useState<AnnotationTab>('highlight');
  const [fraction, setFraction] = useState(0);
  const [chapter, setChapter] = useState<string | null>(null);
  /** 右下角常驻位置指示（REQ-2026-10-05-02）。total 为 0 表示内核没给，只显示百分比 */
  const [position, setPosition] = useState<{ current: number; total: number }>({
    current: 0,
    total: 0,
  });
  const [barVisible, setBarVisible] = useState(true);
  /**
   * 隐藏态屏蔽层是否处于「本次手势还没结束」的保持期（REQ-2026-10-05-03 方案 B）。
   *
   * 只靠 opacity 显隐不够：React 对 pointerdown 是**同步**刷新的，工具栏会在同一次手势里
   * 立刻变成可交互，紧随其后的 mousedown / click 就会落到刚出现的进度条上。
   * 所以按下后屏蔽层要多留一会儿，把整个手势吞完，下一次点按才落到真实控件。
   */
  const [shieldHeld, setShieldHeld] = useState(false);

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
  /** 下拉手势：已下拉的**原始**像素（0 = 没在拉）。阻尼与回弹在这里算。 */
  const [pullRaw, setPullRaw] = useState(0);
  /** 松手回弹中：给页面加 transition；拖动时必须跟手，所以平时没有过渡。 */
  const [pullSettling, setPullSettling] = useState(false);
  /** 上一帧的下拉位移：判断「是不是刚从拉动变成松手」 */
  const pullRawRef = useRef(0);
  const handlePullProgress = useCallback((offset: number) => {
    const prev = pullRawRef.current;
    pullRawRef.current = offset;
    if (offset > 0) {
      setPullSettling(false);
      setPullRaw(offset);
      return;
    }
    if (prev > 0) {
      setPullRaw(0);
      setPullSettling(true);
      window.setTimeout(() => setPullSettling(false), 320);
    }
  }, []);
  /** 一次性操作反馈（加 / 去书签） */
  const [toast, setToast] = useState<string | null>(null);
  /** 翻页动效掉帧的一次性提示气泡 */
  const [turnWarning, setTurnWarning] = useState(false);

  const theme = THEMES[settings.theme];
  /** PDF 本次不做批注（Q11），书签入口与 CFI 记录都要绕开 */
  const isPdf = book?.format === 'pdf';

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

  /** 下拉手势触发时调用的「最新版 toggleBookmark」，赋值见下面 */
  const toggleBookmarkRef = useRef<() => Promise<void>>(async () => {});
  /** 双击工具栏时调用的「最新版 toggleBars」（引擎的回调只注册一次） */
  const toggleBarsRef = useRef<() => void>(() => {});
  /** 工具栏可见性的镜像：切换时要读「当前值」，不能在 setState 的更新函数里做副作用 */
  const barVisibleRef = useRef(true);
  barVisibleRef.current = barVisible;
  /** 自动隐藏计时器：工具栏显隐都从这里统一改，避免多份计时器互相打架 */
  const barTimerRef = useRef<number | undefined>(undefined);

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

  /**
   * 切到「翻纸」时清掉「已提醒」标记：关掉再打开就能再提醒一次（Q9 / D4）。
   *
   * 用 ref 记上一次的值，避免**应用启动**时也把标记清掉 —— 那次不算「用户开了翻纸」，
   * 否则重启后又会被打扰（Q9 明确要求重启不重置）。
   */
  const prevTurnMode = useRef(settings.pageTurn);
  useEffect(() => {
    if (prevTurnMode.current !== settings.pageTurn && settings.pageTurn === 'curl') {
      try {
        localStorage.removeItem(PAGE_TURN_WARN_KEY);
      } catch {
        /* 忽略 */
      }
    }
    prevTurnMode.current = settings.pageTurn;
  }, [settings.pageTurn]);

  // ---- 启动引擎（每本书只做一次）----
  useEffect(() => {
    const host = hostRef.current;
    if (!book || !host) return;

    let disposed = false;
    const engine = new ReaderEngine(host, settingsRef.current);
    engineRef.current = engine;

    let saveTimer: number | undefined;
    /** 上次落库的位置指纹：EPUB 用 CFI，PDF 没有 CFI 就用进度的千分位 */
    let lastSavedKey = '';
    const pdf = book.format === 'pdf';

    const offRelocate = engine.onRelocate((loc) => {
      setFraction(loc.fraction);
      setChapter(loc.chapterLabel);
      setCurrentCfi(loc.cfi);
      setPosition({ current: loc.positionCurrent, total: loc.positionTotal });
      lastLocRef.current = { cfi: loc.cfi, chapter: loc.chapterLabel };

      // 节流写库：位置变化先攒着，停止翻页一会儿后再落库。
      // PDF 没有可用 CFI（内核的 resolveCFI 未实现），位置只记进度百分比。
      const cfi = pdf ? null : loc.cfi;
      const key = pdf ? String(Math.round(loc.fraction * 1000)) : (loc.cfi ?? '');
      if (key !== lastSavedKey) {
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          lastSavedKey = key;
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

    // 翻页动效掉帧：只提醒一次（标记见 PAGE_TURN_WARN_KEY）
    const offStutter = engine.onTurnStutter(() => {
      let warned = false;
      try {
        warned = localStorage.getItem(PAGE_TURN_WARN_KEY) === '1';
      } catch {
        // 无痕模式等写不进去：当作没提醒过，至少当场提示一次
      }
      if (warned) return;
      try {
        localStorage.setItem(PAGE_TURN_WARN_KEY, '1');
      } catch {
        /* 同上，忽略 */
      }
      setTurnWarning(true);
    });

    // 下拉手势：过线后松手就切换当前页的书签
    const offPullProgress = engine.onPullProgress(handlePullProgress);
    const offPullTrigger = engine.onPullTrigger(() => {
      void toggleBookmarkRef.current();
    });

    // 双击正文中间区域切换上下工具栏（REQ-2026-10-05-01）。
    // 只在 Android 注册：Windows 桌面端这次不做这条（Q2）。
    const offToggleBars = isAndroid()
      ? engine.onToggleBars(() => toggleBarsRef.current())
      : () => {};

    (async () => {
      try {
        const bookInfo = await engine.open(book.absPath, {
          lastLocation: book.progressCfi,
          // PDF 没有 CFI，靠进度比例落回页码
          lastFraction: book.progressPct,
        });
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
      offStutter();
      offPullProgress();
      offPullTrigger();
      offToggleBars();
      engine.close();
      engineRef.current = null;
    };
  }, [book, handlePullProgress]);

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

  // ---- 反馈提示显示 1.6 秒后自动消失 ----
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // ---- 设置变化时实时套用（不重建引擎）----
  useEffect(() => {
    engineRef.current?.applySettings(settings);
  }, [settings]);

  /**
   * PDF 首次打开：渲第 1 页生成封面，并把 PDF 自带的标题 / 作者回写书库
   * （REQ-2026-10-05-04 的 Q9 / Q10）。
   *
   * 只在「书库里还没有封面」时做一次：做完 coverPath 就有值了，不会重复跑。
   * 任何一步失败都只写控制台 —— 回写封面不该挡住读书。
   */
  useEffect(() => {
    if (!book || !info || book.format !== 'pdf' || book.coverPath !== null) return;
    let cancelled = false;

    void (async () => {
      try {
        const blob = await engineRef.current?.getCoverBlob();
        if (cancelled) return;
        const cover = blob ? await toJpegBytes(blob) : [];
        if (cancelled) return;

        const title = info.title?.trim() || null;
        const author = info.author?.trim() || null;
        // 拿不到 PDF 自己的标题就继续用文件名，别把已有标题清掉
        if (title !== null) await api.renameBook(book.id, title, author);
        if (cover.length > 0) await api.saveBookCover(book.id, cover);

        const fresh = await api.getBook(book.id);
        if (!cancelled && fresh) setBook(fresh);
      } catch (e) {
        console.error('PDF 封面与元数据回写失败', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [book, info]);

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
  const bump = useCallback(() => {
    setBarVisible(true);
    window.clearTimeout(barTimerRef.current);
    barTimerRef.current = window.setTimeout(() => setBarVisible(false), BAR_HIDE_MS);
  }, []);

  /**
   * 显示 / 隐藏切换（双击正文中间区域触发，REQ-2026-10-05-01）。
   * 切到显示时同样开始计时，之后照旧自动隐藏。
   */
  const toggleBars = useCallback(() => {
    window.clearTimeout(barTimerRef.current);
    const next = !barVisibleRef.current;
    setBarVisible(next);
    if (next) barTimerRef.current = window.setTimeout(() => setBarVisible(false), BAR_HIDE_MS);
  }, []);
  toggleBarsRef.current = toggleBars;

  useEffect(() => {
    bump(); // 刚进入时也启动计时

    window.addEventListener('pointermove', bump);
    window.addEventListener('pointerdown', bump);
    window.addEventListener('keydown', bump);
    return () => {
      window.clearTimeout(barTimerRef.current);
      window.removeEventListener('pointermove', bump);
      window.removeEventListener('pointerdown', bump);
      window.removeEventListener('keydown', bump);
    };
  }, [bump]);

  /**
   * 隐藏态屏蔽层的按下：这一整只手势被吞掉，只负责把工具栏叫出来。
   *
   * 必须 stopPropagation —— 否则 window 上的 pointerdown 仍会 bump()，
   * 「吞掉手势」就白吞了（REQ-2026-10-05-03）。
   * preventDefault 则让触摸不再派发兼容鼠标事件，先断掉「同一手势二次命中」。
   */
  function handleShieldDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    setShieldHeld(true);
    bump();
  }

  /**
   * ⚠️ 屏蔽层不能一到 pointerup 就撤掉。
   *
   * click 是在 pointerup **之后**才派发的，那会儿工具栏已经显示、真实控件也恢复了
   * pointer-events，click 就会落到「设置」这类按钮上。实测就是这么翻的车：
   * 隐藏态点顶栏「设置」所在的位置 → 工具栏出来了，设置面板也被一起点开了。
   * 所以要让它留到 click 被自己吞掉为止；拖拽这类不产生 click 的手势用定时器兜底，
   * 免得屏蔽层卡住不走。
   */
  function handleShieldClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    releaseShield();
  }

  function scheduleShieldRelease() {
    window.setTimeout(releaseShield, 400);
  }

  function releaseShield() {
    setShieldHeld(false);
  }

  /** 屏蔽层在「工具栏隐藏」或「本次手势还没结束」时存在 */
  const shieldActive = !barVisible || shieldHeld;

  const toc = useMemo(() => info?.toc ?? [], [info]);

  /** 当前布局：书签按它隔离，单栏的不会在双栏里显示（REQ-2026-10-11-06）。 */
  const layout: AnnotationLayout = settings.maxColumnCount >= 2 ? 'double' : 'single';

  /** 当前页有没有**本布局**的书签。 */
  const bookmarkHere =
    currentCfi !== null &&
    annotations.some((a) => a.type === 'bookmark' && a.cfi === currentCfi && a.layout === layout);

  /** 批注（高亮/笔记）条数。顶栏「批注」按钮只数批注，书签已分出去（REQ-2026-10-11-07）。 */
  const highlightCount = annotations.filter((a) => a.type === 'highlight').length;

  /** 下拉阻尼：跟手但不 1:1；上限 150px，免得拉到底整页飞出屏幕。 */
  const pullDamped = Math.min(pullRaw * 0.55, 150);
  const pullArmed = pullRaw >= PULL_TRIGGER_PX;
  /** 本页已有书签时下拉是「删除」，提示文案要跟着变（REQ-2026-10-11-05） */
  const pullAction = bookmarkHere ? '删除' : '添加';

  /** 缎带只在「翻页」模式出现：滚动模式没有「页」，B10 定案不管它（不显示、不响应手势）。 */
  const showRibbon = bookmarkHere && settings.flow === 'paginated';

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
    // PDF 本次不做批注，也没有可用的 CFI（Q11）
    if (book.format === 'pdf') return;
    const { cfi, chapter: ch } = lastLocRef.current;
    if (!cfi) return;

    // 读 ref 而不是 state：下拉手势的回调只注册一次，闭包里的 annotations 会是旧值。
    // 只看**当前布局**的书签：单栏的在双栏里不算「已加」，反过来也一样（REQ-2026-10-11-06）。
    const existing = annotationsRef.current.find(
      (a) => a.type === 'bookmark' && a.cfi === cfi && a.layout === layout,
    );
    if (existing) {
      await handleAnnotationDelete(existing);
      setToast('已去掉书签');
      return;
    }

    try {
      const created = await api.addAnnotation({
        bookId: book.id,
        kind: 'bookmark',
        cfi,
        chapter: ch,
        layout,
      });
      setAnnotations((list) => [created, ...list]);
      setToast('已加书签 ★');
    } catch (e) {
      setError(`添加书签失败：${readableError(e)}`);
    }
  }

  /**
   * 给「下拉手势」用的最新函数引用。
   *
   * 手势回调在引擎里只注册一次，直接闭包 toggleBookmark 会永远用第一次渲染的那份，
   * 而它依赖 book 与批注列表，必须每次拿最新的。
   */
  toggleBookmarkRef.current = toggleBookmark;

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
      className="relative flex h-screen flex-col overflow-hidden"
      style={{ background: theme.bg, color: theme.fg }}
    >
      {/* 顶栏。配色跟 **App 主题**（Q17），阅读主题只管正文页面 */}
      <header
        className="z-20 flex shrink-0 items-center gap-3 border-b border-app-border bg-app-surface px-4 text-app-muted transition-opacity duration-300"
        style={{
          height: 48,
          opacity: barVisible ? 1 : 0,
          pointerEvents: barVisible ? 'auto' : 'none',
        }}
      >
        <button
          type="button"
          onClick={() => navigate('/')}
          className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-app-hover"
        >
          ← 书库
        </button>

        <div className="min-w-0 flex-1 truncate text-sm text-app-fg">
          {book?.title ?? ''}
          {chapter !== null && <span className="ml-2 text-xs text-app-muted">{chapter}</span>}
        </div>

        {/* PDF 本次不做批注，书签按钮直接不出现（Q11：宁可没有，也别「能点但没反应」） */}
        {!isPdf && (
          <button
            type="button"
            onClick={() => void toggleBookmark()}
            aria-label={bookmarkHere ? '去掉书签' : '加书签'}
            title={bookmarkHere ? '去掉书签' : '加书签'}
            className={`cursor-pointer rounded px-2 py-1 text-sm hover:bg-app-hover ${bookmarkHere ? 'text-amber-500' : ''}`}
          >
            {bookmarkHere ? '★' : '☆'}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setShowToc((v) => !v);
            setShowSettings(false);
            setShowAnnotations(false);
          }}
          className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-app-hover"
        >
          目录
        </button>
        <button
          type="button"
          onClick={() => {
            setShowAnnotations((v) => !v);
            setAnnotationTab('highlight');
            setShowToc(false);
            setShowSettings(false);
          }}
          className={`cursor-pointer rounded px-2 py-1 text-sm hover:bg-app-hover ${showAnnotations ? 'text-app-accent' : ''}`}
        >
          批注{highlightCount > 0 ? ` ${highlightCount}` : ''}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowSettings((v) => !v);
            setShowToc(false);
            setShowAnnotations(false);
          }}
          className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-app-hover"
        >
          设置
        </button>
        <AppThemeToggle compact />
      </header>

      {/* 正文区。overflow-hidden：下拉时页面移出上边，不溢出到顶栏 / 底栏 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* 下拉提示：平时被页面盖住，下拉才露出顶部灰区 + 一行字（REQ-2026-10-11-05） */}
        {pullRaw > 0 && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{ background: `${theme.muted}1f` }}
          >
            <p
              className="mt-5 text-center text-xs transition-opacity duration-150"
              style={{ color: theme.muted, opacity: pullDamped >= 40 ? 1 : 0 }}
            >
              {pullArmed ? `↑ 松手${pullAction}书签` : `↓ 继续下拉${pullAction}书签`}
            </p>
          </div>
        )}

        {/* 页面：下拉时整块跟着走（只动正文，顶栏 / 底栏不动） */}
        <div
          className="absolute inset-0"
          style={{
            transform: `translateY(${pullDamped}px)`,
            transition: pullSettling ? 'transform 300ms cubic-bezier(0.22, 0.61, 0.36, 1)' : 'none',
          }}
        >
          <div ref={hostRef} className="h-full w-full" />

          {/* 页上书签缎带（REQ-2026-10-11-04）：仅展示、不可点，跳转走侧栏书签列表 */}
          {showRibbon && error === null && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0 z-[12]"
              style={{
                right: RIBBON_INSET_PX,
                width: 20,
                height: 34,
                background: BOOKMARK_COLORS[settings.bookmarkColor],
                clipPath: 'polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%)',
                filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35))',
                animation: 'bookmark-drop 320ms cubic-bezier(0.22, 0.61, 0.36, 1)',
              }}
            />
          )}
        </div>

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

        {/* 加 / 去书签的一次性反馈 */}
        {toast !== null && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
            <span
              className="rounded-full border px-3 py-1 text-xs backdrop-blur"
              style={{
                borderColor: `${theme.muted}55`,
                background: `${theme.bg}dd`,
                color: theme.fg,
              }}
            >
              {toast}
            </span>
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

      {/* 右下角常驻位置指示（REQ-2026-10-05-02）。
          刻意设为不接收指针事件：它压在右下角，否则会挡住翻页点按区。
          底栏显示时上移让位，隐藏时贴近屏幕底部（用户截图里的位置）。

          ⚠️ 批注操作栏打开时必须**不显示**：那条栏也是贴着屏幕底部的，
          而角标是绝对定位（z-[15]，比在正常流里的操作栏还高一层），
          叠上去就会压在「笔记」按钮上（真机截图就是这么暴露的）。
          这时底栏的进度条与百分比仍然可见，不差这一个角标。 */}
      {!loading && error === null && editor === null && (
        <div
          className="pointer-events-none absolute right-3 z-[15] text-right text-xs tabular-nums transition-all duration-300"
          style={{ bottom: barVisible ? 52 : 10, color: theme.muted }}
        >
          {position.total > 0 && (
            <span>
              {position.current} / {position.total}
            </span>
          )}
          <span className={position.total > 0 ? 'ml-2' : undefined}>{formatPercent(fraction)}</span>
        </div>
      )}

      {/* 隐藏态屏蔽层（REQ-2026-10-05-03 方案 B）。
          工具栏隐藏时盖在顶栏 / 底栏之上：按下先被它整只吞掉、只负责把工具栏叫出来，
          这样同一次手势的 mousedown / click 不会再落到刚显示出来的进度条或按钮上。
          z-[25]：压得住工具栏（z-20），又低于侧栏面板（z-30），不会挡住面板操作。 */}
      {shieldActive && (
        <>
          <div
            aria-hidden="true"
            onPointerDown={handleShieldDown}
            onPointerUp={scheduleShieldRelease}
            onPointerCancel={scheduleShieldRelease}
            onLostPointerCapture={scheduleShieldRelease}
            onClick={handleShieldClick}
            className="absolute inset-x-0 top-0 z-[25]"
            style={{ height: 48 }}
          />
          <div
            aria-hidden="true"
            onPointerDown={handleShieldDown}
            onPointerUp={scheduleShieldRelease}
            onPointerCancel={scheduleShieldRelease}
            onLostPointerCapture={scheduleShieldRelease}
            onClick={handleShieldClick}
            className="absolute inset-x-0 bottom-0 z-[25]"
            style={{ height: 44 }}
          />
        </>
      )}

      {/* 批注操作栏。
          刻意放在底部而不是浮在选区旁边 —— Android 选中文字会先弹系统自己的
          「复制 / 粘贴 / 网络搜索」原生浮层，它永远贴着选区、且画在 WebView 之上，
          浮在选区旁边的任何东西都会被它盖住（真机实测）。 */}
      {editor !== null && (
        <AnnotationEditor
          target={editor}
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

      {/* 底栏进度 */}
      <footer
        className="z-20 flex shrink-0 items-center gap-3 border-t border-app-border bg-app-surface px-4 transition-opacity duration-300"
        style={{
          height: 44,
          opacity: barVisible ? 1 : 0,
          pointerEvents: barVisible ? 'auto' : 'none',
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
        <span className="w-12 text-right text-xs tabular-nums text-app-muted">
          {formatPercent(fraction)}
        </span>
      </footer>

      {/* 翻页动效掉帧的一次性提示（Q9）：只弹一次，标记见 PAGE_TURN_WARN_KEY */}
      {turnWarning && (
        <div className="pointer-events-none absolute inset-x-0 bottom-14 z-30 flex justify-center px-4">
          <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs text-app-fg shadow-lg">
            <span className="min-w-0">翻页动效有点卡，建议改成「滑动」。</span>
            <button
              type="button"
              onClick={() => {
                updateSettings({ pageTurn: 'slide' });
                setTurnWarning(false);
              }}
              className="shrink-0 cursor-pointer rounded border border-app-border px-2 py-0.5 text-xs text-app-accent hover:bg-app-hover"
            >
              改滑动
            </button>
            <button
              type="button"
              onClick={() => setTurnWarning(false)}
              className="shrink-0 cursor-pointer rounded px-2 py-0.5 text-xs text-app-muted hover:bg-app-hover"
            >
              知道了
            </button>
          </div>
        </div>
      )}

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
            tab={annotationTab}
            onTabChange={setAnnotationTab}
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
