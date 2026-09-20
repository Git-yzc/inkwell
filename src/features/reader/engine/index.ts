/**
 * foliate-js 适配层。
 *
 * ⚠️ 这是全项目**唯一**允许 import foliate-js 的文件（见 AGENTS.md 铁律 3）。
 * 别的地方一律只依赖 ./types.ts 里的稳定接口。
 *
 * 之所以要这层隔离：foliate-js 官方 README 写明
 * "It's not stable. Expect it to break and the API to change at any time."
 * 升级内核时，改动应当被限制在本文件内。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
// ⚠️ 这条**副作用导入**不能删，也不能改成普通的命名导入。
//
// view.js 末尾会执行 customElements.define('foliate-view', View) 注册自定义元素。
// 而 View 在本文件里只出现在**类型位置**，打包器会据此判定整条导入无用并删掉，
// 于是注册代码从未执行：document.createElement('foliate-view') 拿到的是普通
// HTMLElement，调用 open() 直接报 "open is not a function"（实测踩过这个坑）。
// 显式保留一条副作用导入即可。
import 'foliate-js/view.js';
import { Overlayer } from 'foliate-js/overlayer.js';
import type { FoliateLocation, FoliateTocItem, View } from 'foliate-js/view.js';

import {
  type BookInfo,
  type HighlightView,
  highlightColor,
  type ReaderLocation,
  type RendererSettings,
  type SelectionInfo,
  THEMES,
  type TocItem,
} from './types';

/** 打开书籍时的可选项。 */
export interface OpenOptions {
  /** 上次读到的 CFI，用于恢复位置 */
  lastLocation?: string | null;
}

type RelocateListener = (loc: ReaderLocation) => void;
type LoadListener = (e: { index: number }) => void;
type SelectionListener = (sel: SelectionInfo | null) => void;
type AnnotationClickListener = (cfi: string) => void;
/**
 * 下拉进度。
 * - `true`：已过触发线，松手就生效
 * - `false`：正在下拉，还没到线
 * - `null`：没有进行中的手势
 */
type PullProgressListener = (armed: boolean | null) => void;
/** 下拉到触发线后松手。 */
type PullTriggerListener = () => void;

/** foliate 画批注时交回来的东西（见 view.js 的 addAnnotation）。 */
interface DrawAnnotationDetail {
  draw: (drawer: typeof Overlayer.highlight, options: { color: string }) => void;
  annotation: { color?: string | null };
}

/** 选区防抖：拖拽时 selectionchange 会连发，等手停一下再弹浮层。 */
const SELECTION_DEBOUNCE_MS = 150;

/** 下拉多少像素开始给提示（还没到触发线）。 */
const PULL_HINT_PX = 36;
/** 下拉多少像素算「要加书签」——松手即触发。 */
const PULL_TRIGGER_PX = 96;
/** 竖直位移至少是水平位移的多少倍才算「下拉」而不是横向滑动。 */
const PULL_VERTICAL_RATIO = 1.6;

/** 滚轮累积多少像素才翻一页。 */
const WHEEL_STEP = 50;
/** 翻页后的冷却时间（毫秒）：一次快速拨动会连发几十个 wheel 事件，没有冷却会一蹦好几页。 */
const WHEEL_COOLDOWN_MS = 250;

/**
 * 取到书籍文件。
 *
 * 优先走 Tauri 的 asset 协议：由 Rust 直接提供文件，不必把字节经 IPC 搬一遍。
 * 拿不到时回退到 fs 插件按路径读——asset 协议在个别平台/配置下可能不可用，
 * 有这条兜底就不会出现「点了书打不开」。
 */
async function loadBookFile(absPath: string): Promise<File> {
  const name = absPath.split(/[\\/]/).pop() || 'book.epub';

  try {
    const res = await fetch(convertFileSrc(absPath));
    if (res.ok) {
      const blob = await res.blob();
      if (blob.size > 0) return new File([blob], name);
    }
  } catch {
    // 忽略，走下面的回退
  }

  const bytes = await readFile(absPath);
  return new File([bytes as BlobPart], name);
}

/** 元数据里的标题可能是字符串，也可能是 { 语言: 标题 } 映射，统一取一个。 */
function pickText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const vals = Object.values(v as Record<string, unknown>);
    for (const x of vals) if (typeof x === 'string' && x.trim()) return x.trim();
  }
  return null;
}

function normalizeToc(items: FoliateTocItem[] | undefined, prefix = ''): TocItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((it, i) => {
    // 目录里 href 可能重复（同一锚点被多个标题引用），因此用位置生成稳定 id
    const id = prefix === '' ? String(i) : `${prefix}.${i}`;
    return {
      id,
      label: typeof it?.label === 'string' && it.label.trim() ? it.label.trim() : '未命名章节',
      href: typeof it?.href === 'string' ? it.href : '',
      subitems: normalizeToc(Array.isArray(it?.subitems) ? it.subitems : [], id),
    };
  });
}

function toLocation(raw: FoliateLocation | null, fallbackSectionTotal: number): ReaderLocation {
  const label = raw?.tocItem?.label;
  return {
    cfi: raw?.cfi ?? null,
    fraction: typeof raw?.fraction === 'number' ? raw.fraction : 0,
    sectionIndex: raw?.section?.current ?? 0,
    sectionTotal: raw?.section?.total ?? fallbackSectionTotal,
    chapterLabel: typeof label === 'string' && label.trim() ? label.trim() : null,
    remainingSeconds: typeof raw?.time?.total === 'number' ? raw.time.total : null,
  };
}

/**
 * 语言标签是否属于「该套用中文排版」的语种。
 *
 * 中日韩共用 CJK 标点与断行规则，首行缩进也是这几门语言书籍的惯例；
 * 西文书不该缩进，所以必须先判断语言再决定要不要输出这些规则。
 * 除了 zh / ja / ko，还接受 ISO 639-2/3 的写法（chi、cmn、yue、jpn、kor）。
 */
export function isCjkLanguage(tag: string | null | undefined): boolean {
  if (!tag) return false;
  return /^(zh|ja|ko|chi|cmn|yue|wuu|jpn|kor)/i.test(tag.trim());
}

/**
 * 中文排版规则。只在判定为 CJK 书籍时追加。
 *
 * 三条规则分别对应：
 * 1. 首行缩进两字 —— 中文书籍靠缩进而非段间距区分段落
 * 2. 行首禁则 —— 不允许 。，、」 等标点出现在行首
 * 3. 中西文间距 / 标点挤压 —— 后两条属性较新，不支持的 WebView 会直接忽略，
 *    属于「有则更好」，不会影响基本排版（见 docs/BACKLOG.md 的实测记录）
 */
const CJK_CSS = `
    /* 1. 首行缩进两字 */
    p, dd { text-indent: 2em; }

    /* 标题、表格、图注、列表项里的段落不该缩进；作者指定了对齐方式的同理 */
    h1, h2, h3, h4, h5, h6, figcaption, caption, th, td, li p, li dd,
    [align], [align='center'], [align='right'] { text-indent: 0; }

    /* 2. 行首禁则 + 3. 中西文间距与标点挤压 */
    html {
      line-break: strict;
      hanging-punctuation: allow-end last;
      text-autospace: normal;
      text-spacing-trim: normal;
    }
`;

/** 按设置拼出注入书籍文档的 CSS。cjk 为 true 时追加中文排版规则。 */
function buildCss(s: RendererSettings, cjk: boolean): string {
  const theme = THEMES[s.theme];
  const family = s.fontFamily ? `font-family: ${s.fontFamily} !important;` : '';

  return `
    @namespace epub "http://www.idpf.org/2007/ops";

    html {
      color: ${theme.fg} !important;
      background: ${theme.bg} !important;
      font-size: ${s.fontSize}px !important;
      ${family}
    }
    body {
      color: ${theme.fg} !important;
      background: ${theme.bg} !important;
    }

    /* 正文排版：中文习惯两端对齐、行距略大、标点允许悬挂 */
    p, li, blockquote, dd, div {
      line-height: ${s.lineHeight} !important;
      text-align: justify;
      hanging-punctuation: allow-end last;
      widows: 2;
    }

    /* 作者显式指定了对齐方式时不要覆盖 */
    [align="left"]   { text-align: left; }
    [align="right"]  { text-align: right; }
    [align="center"] { text-align: center; }

    a:link { color: ${theme.fg}; }

    img, svg, video { max-width: 100%; }

    pre { white-space: pre-wrap !important; }

    /* 脚注类内容默认折叠，由阅读器另行处理 */
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] { display: none; }

    ${cjk ? CJK_CSS : ''}
  `;
}

export class ReaderEngine {
  #view: View;
  #settings: RendererSettings | null = null;
  #sectionCount = 0;
  #relocateListeners = new Set<RelocateListener>();
  #loadListeners = new Set<LoadListener>();
  #selectionListeners = new Set<SelectionListener>();
  #annotationClickListeners = new Set<AnnotationClickListener>();
  #pullProgressListeners = new Set<PullProgressListener>();
  #pullTriggerListeners = new Set<PullTriggerListener>();
  #pullDoc: Document | null = null;
  #pullStart: { x: number; y: number } | null = null;
  #pullPhase: 'idle' | 'pulling' | 'armed' = 'idle';
  /** 一次手势只触发一次，松手才复位 */
  #pullFired = false;
  #opened = false;
  /** 已挂上滚轮监听的书籍文档；换章节会换文档，用它去重 */
  #wheelDoc: Document | null = null;
  #wheelAccum = 0;
  #wheelUnlockAt = 0;
  /** 已挂上选区监听的书籍文档（同样要按文档去重） */
  #selectionDoc: Document | null = null;
  #selectionTimer: number | undefined;
  /** 当前显示章节的序号，选区算 CFI 时要用 */
  #sectionIndex = 0;
  /** 当前书的高亮，key 是 CFI（foliate 也拿 CFI 当 overlayer 的 key） */
  #highlights = new Map<string, HighlightView>();

  constructor(host: HTMLElement, settings: RendererSettings) {
    this.#settings = settings;

    this.#view = document.createElement('foliate-view') as unknown as View;
    this.#view.style.display = 'block';
    this.#view.style.width = '100%';
    this.#view.style.height = '100%';
    host.appendChild(this.#view);

    this.#view.addEventListener('relocate', (e) => {
      const detail = (e as CustomEvent<FoliateLocation | null>).detail ?? null;
      const loc = toLocation(detail, this.#sectionCount);
      for (const fn of this.#relocateListeners) fn(loc);
    });

    this.#view.addEventListener('load', (e) => {
      const detail = (e as CustomEvent<{ doc?: Document; index: number }>).detail;
      // 换章节时内核会重建 iframe 文档，样式、滚轮与选区监听都要重新挂
      this.#applyRendererAttributes();
      this.#bindWheel(detail?.doc);
      this.#bindSelection(detail?.doc);
      this.#bindPullDown(detail?.doc);
      this.#sectionIndex = detail?.index ?? 0;
      for (const fn of this.#loadListeners) fn({ index: detail?.index ?? 0 });
    });

    // 内核把「画批注」这件事交回给我们：它只负责解析 CFI 与取 range，
    // 用什么颜色、画成什么样由这边决定（见 view.js 的 addAnnotation）。
    this.#view.addEventListener('draw-annotation', (e) => {
      const detail = (e as CustomEvent<DrawAnnotationDetail>).detail;
      detail.draw(Overlayer.highlight, { color: highlightColor(detail.annotation.color) });
    });

    // ⚠️ create-overlay 是在 overlayer **真正挂上去之前**发的
    // （view.js 先 emit、后 attach），所以得等一个微任务再画，
    // 否则 getContents() 里还没有 overlayer，批注一个都画不出来。
    this.#view.addEventListener('create-overlay', () => {
      void Promise.resolve().then(() => this.#drawHighlights());
    });

    // 点中已有高亮时内核会告诉我们点到了哪个 CFI
    this.#view.addEventListener('show-annotation', (e) => {
      const detail = (e as CustomEvent<{ value?: string }>).detail;
      if (typeof detail?.value !== 'string') return;
      for (const fn of this.#annotationClickListeners) fn(detail.value);
    });
  }

  async open(absPath: string, opts: OpenOptions = {}): Promise<BookInfo> {
    // ⚠️ 换书要清掉上一本的高亮，而且必须清在**开头**。
    //
    // 批注是从本地库读的（毫秒级），open() 要几秒；新书的 setHighlights() 常常在
    // open() 还没返回时就跑完了。清空若放在结尾，就会把刚设进来的新批注一并抹掉，
    // 表现为「重开书后高亮全没了」（实测踩到过两次）。
    this.#highlights.clear();

    const file = await loadBookFile(absPath);
    await this.#view.open(file);

    const book = this.#view.book;
    const toc = normalizeToc(book?.toc);
    this.#sectionCount = book?.sections?.length ?? 0;

    const last = opts.lastLocation ?? null;
    await this.#view.init({ lastLocation: last, showTextStart: !last });

    this.#opened = true;
    this.#applyRendererAttributes();
    // ⚠️ 这里必须补一次重画。
    //
    // setHighlights() 往往在 #opened 还是 false 的时候就跑完了 —— 那次重画会被
    // #drawHighlights 的守卫挡掉，而 open() 期间触发的 create-overlay 同样发生在
    // #opened 置位之前。不补这一次，重开书后高亮就不会出现在正文里。
    void this.#drawHighlights();

    const fixedLayout = book?.rendition?.layout === 'pre-paginated';
    return {
      title: pickText(book?.metadata?.title),
      language: pickText(book?.metadata?.language),
      toc,
      sectionCount: this.#sectionCount,
      fixedLayout,
    };
  }

  close(): void {
    this.#wheelDoc?.removeEventListener('wheel', this.#onWheel);
    this.#wheelDoc = null;
    this.#wheelAccum = 0;
    this.#wheelUnlockAt = 0;
    this.#selectionDoc?.removeEventListener('selectionchange', this.#onSelectionChange);
    this.#selectionDoc = null;
    window.clearTimeout(this.#selectionTimer);
    this.#unbindPullDown();
    try {
      this.#view.close();
    } catch {
      // 已经卸载过就忽略
    }
    this.#view.remove();
    this.#relocateListeners.clear();
    this.#loadListeners.clear();
    this.#selectionListeners.clear();
    this.#annotationClickListeners.clear();
    this.#pullProgressListeners.clear();
    this.#pullTriggerListeners.clear();
    this.#highlights.clear();
  }

  /* ---------------------------------------------------------------- 批注 */

  /**
   * 全量替换当前书的高亮（新增/改色/删除都走这里）。
   *
   * 列表不大（一本书几十条量级），增量维护的复杂度不值当，直接全量对齐。
   */
  setHighlights(list: HighlightView[]): void {
    const next = new Map(list.map((h) => [h.cfi, h]));

    // 先摘掉已经不存在的，否则删掉的高亮会一直留在画面上
    for (const cfi of this.#highlights.keys()) {
      if (!next.has(cfi)) void this.#view.deleteAnnotation({ value: cfi });
    }

    this.#highlights = next;
    void this.#drawHighlights();
  }

  /** 把当前书的高亮全部交给内核去画（不在本章的会被内核自行忽略）。 */
  async #drawHighlights(): Promise<void> {
    if (!this.#opened) return;
    for (const h of this.#highlights.values()) {
      await this.#view.addAnnotation({ value: h.cfi, color: h.color });
    }
  }

  /** 清掉正文里的选区（加完批注后调用，免得浮层一直挂着）。 */
  clearSelection(): void {
    if (this.#opened) this.#view.deselect();
  }

  onSelection(fn: SelectionListener): () => void {
    this.#selectionListeners.add(fn);
    return () => this.#selectionListeners.delete(fn);
  }

  onAnnotationClick(fn: AnnotationClickListener): () => void {
    this.#annotationClickListeners.add(fn);
    return () => this.#annotationClickListeners.delete(fn);
  }

  /**
   * 监听书籍文档里的选区。
   *
   * 用 selectionchange 而不是 pointerup：手机上长按选词之后还会拖手柄，
   * pointerup 早就过去了，selectionchange 才是唯一可靠的信号。
   * 拖拽期间它连发，所以加一层防抖。
   */
  #bindSelection(doc: Document | undefined): void {
    if (!doc || this.#selectionDoc === doc) return;
    this.#selectionDoc?.removeEventListener('selectionchange', this.#onSelectionChange);
    this.#selectionDoc = doc;
    doc.addEventListener('selectionchange', this.#onSelectionChange);
  }

  #onSelectionChange = (): void => {
    window.clearTimeout(this.#selectionTimer);
    this.#selectionTimer = window.setTimeout(() => this.#emitSelection(), SELECTION_DEBOUNCE_MS);
  };

  #emitSelection(): void {
    const info = this.#currentSelection();
    for (const fn of this.#selectionListeners) fn(info);
  }

  #currentSelection(): SelectionInfo | null {
    if (!this.#opened) return null;
    const doc = this.#selectionDoc;
    const sel = doc?.defaultView?.getSelection();
    if (!doc || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const text = sel.toString().trim();
    if (!text) return null;

    const range = sel.getRangeAt(0);

    // 书籍在 iframe 里：range 的 rect 是 iframe 局部坐标，
    // 要加上 iframe 在**顶层视口**里的位置，外层 UI 才能对齐。
    // （paginator 用 px 定位 iframe，没有 transform，所以直接相加即可。）
    const frame = doc.defaultView?.frameElement as HTMLElement | null;
    const frameRect = frame?.getBoundingClientRect();
    const r = range.getBoundingClientRect();

    return {
      text,
      cfi: this.#view.getCFI(this.#sectionIndex, range),
      rect: {
        x: (frameRect?.left ?? 0) + r.left,
        y: (frameRect?.top ?? 0) + r.top,
        width: r.width,
        height: r.height,
      },
    };
  }

  get opened(): boolean {
    return this.#opened;
  }

  /* ---------------------------------------------------------------- 导航 */

  async next(): Promise<void> {
    if (this.#opened) await this.#view.next();
  }

  async prev(): Promise<void> {
    if (this.#opened) await this.#view.prev();
  }

  /** target 可以是 CFI 串、章节序号，或目录项的 href。 */
  async goTo(target: string | number): Promise<void> {
    if (!this.#opened) return;
    if (typeof target === 'string' && target.length === 0) return;
    await this.#view.goTo(target);
  }

  async goToFraction(fraction: number): Promise<void> {
    if (!this.#opened) return;
    await this.#view.goToFraction(Math.min(1, Math.max(0, fraction)));
  }

  /** 章节起点在全书中的进度，用于进度条刻度（暂未使用，留给阶段 2）。 */
  sectionFractions(): number[] {
    return this.#opened ? this.#view.getSectionFractions() : [];
  }

  /* ---------------------------------------------------------------- 设置 */

  applySettings(settings: RendererSettings): void {
    this.#settings = settings;
    this.#applyRendererAttributes();
  }

  #applyRendererAttributes(): void {
    const s = this.#settings;
    const renderer = this.#view.renderer;
    if (!s || !renderer) return;

    renderer.setAttribute('flow', s.flow);
    renderer.setAttribute('margin', String(s.margin));
    renderer.setAttribute('max-column-count', String(s.maxColumnCount));

    // setStyles 会把 CSS 注入书籍文档；fixed-layout（漫画）不套用文字排版
    if (this.#view.book?.rendition?.layout !== 'pre-paginated') {
      renderer.setStyles?.(buildCss(s, this.#resolveCjk(s)));
    }
  }

  /**
   * 这本书要不要套用中文排版。
   *
   * auto 只看**书籍自身**的语言，不拿 navigator.language 兜底：界面是中文的，
   * 用界面语言兜底会把英文书也判成中文，正好把「英文书不缩进」这条给毁了。
   * 语言元数据缺失时按「不套用」处理 —— 不动版式比猜错版式好，用户可在设置里手动改成「开」。
   */
  #resolveCjk(s: RendererSettings): boolean {
    if (s.cjkTypography === 'on') return true;
    if (s.cjkTypography === 'off') return false;
    return isCjkLanguage(pickText(this.#view.book?.metadata?.language));
  }

  /* ------------------------------------------------------------ 下拉手势 */

  /** 下拉进度（用于显示提示）。 */
  onPullProgress(fn: PullProgressListener): () => void {
    this.#pullProgressListeners.add(fn);
    return () => this.#pullProgressListeners.delete(fn);
  }

  /** 下拉过线并松手。 */
  onPullTrigger(fn: PullTriggerListener): () => void {
    this.#pullTriggerListeners.add(fn);
    return () => this.#pullTriggerListeners.delete(fn);
  }

  /**
   * 监听正文里的「下拉」手势（向下滑）。
   *
   * **只在翻页模式下启用**：
   * - 翻页模式下正文没有竖直滚动，向下拖本来就是空操作。而且内核的 `snap()`
   *   在横排下只看 `vx`（见 paginator.js:805），所以纯竖直拖动不会误翻页 ——
   *   这条是读源码确认的，不是猜的。
   * - 滚动模式下向下拖就是正常的向上滚页，抢过来会很别扭，所以不启用。
   *
   * 另外，正在选词时不触发：那时候用户拖的是选择手柄，不是下拉。
   */
  #bindPullDown(doc: Document | undefined): void {
    if (!doc || this.#pullDoc === doc) return;
    this.#unbindPullDown();
    this.#pullDoc = doc;
    // 只读不拦截，所以 passive 即可（也省得拖慢滚动）
    doc.addEventListener('touchstart', this.#onPullStart, { passive: true });
    doc.addEventListener('touchmove', this.#onPullMove, { passive: true });
    doc.addEventListener('touchend', this.#onPullEnd, { passive: true });
    doc.addEventListener('touchcancel', this.#onPullEnd, { passive: true });
  }

  #unbindPullDown(): void {
    const doc = this.#pullDoc;
    if (doc) {
      doc.removeEventListener('touchstart', this.#onPullStart);
      doc.removeEventListener('touchmove', this.#onPullMove);
      doc.removeEventListener('touchend', this.#onPullEnd);
      doc.removeEventListener('touchcancel', this.#onPullEnd);
    }
    this.#pullDoc = null;
    this.#resetPull();
  }

  /** 收起提示并把状态归零。 */
  #resetPull(): void {
    this.#pullStart = null;
    this.#pullFired = false;
    this.#setPullPhase('idle');
  }

  #setPullPhase(phase: 'idle' | 'pulling' | 'armed'): void {
    if (phase === this.#pullPhase) return;
    this.#pullPhase = phase;
    const value = phase === 'idle' ? null : phase === 'armed';
    for (const fn of this.#pullProgressListeners) fn(value);
  }

  #onPullStart = (e: TouchEvent): void => {
    if (this.#settings?.flow !== 'paginated' || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!t) return;
    this.#pullStart = { x: t.clientX, y: t.clientY };
    this.#pullFired = false;
  };

  #onPullMove = (e: TouchEvent): void => {
    const start = this.#pullStart;
    if (!start || this.#pullFired || this.#settings?.flow !== 'paginated') return;

    const t = e.touches[0];
    if (!t) return;

    // 正在选词：用户拖的是选择手柄，不是下拉
    if (this.#selectionDoc?.defaultView?.getSelection()?.isCollapsed === false) {
      this.#setPullPhase('idle');
      return;
    }

    const dy = t.clientY - start.y;
    const dx = Math.abs(t.clientX - start.x);

    // 往上拖、或横向为主的滑动，都不算这个手势
    if (dy < PULL_HINT_PX || dy < dx * PULL_VERTICAL_RATIO) {
      this.#setPullPhase('idle');
      return;
    }

    this.#setPullPhase(dy >= PULL_TRIGGER_PX ? 'armed' : 'pulling');
  };

  #onPullEnd = (): void => {
    const fire = this.#pullPhase === 'armed' && !this.#pullFired;
    this.#pullStart = null;
    this.#pullFired = true;
    this.#setPullPhase('idle');
    if (fire) for (const fn of this.#pullTriggerListeners) fn();
  };

  /* ------------------------------------------------------------ 滚轮翻页 */

  /**
   * 给书籍文档挂滚轮监听，让「翻页」模式也能用滚轮翻页。
   *
   * 内核的 paginator 完全没有 wheel 处理：paginated 模式下容器是
   * `overflow: hidden`，滚轮事件没人接管就直接丢了。
   *
   * 两个关键点：
   * 1. 滚轮事件产生在书籍所在的 iframe **内部**，不会冒泡到外层文档，
   *    所以只能挂在 load 事件交出来的 doc 上（内核自己挂 touchstart 也是这么做的）。
   * 2. 换章节时内核会重建 iframe 文档并再次触发 load，用 #wheelDoc 去重，
   *    避免同一文档重复绑定。切换 flow 模式不会重建文档（内核只重排），
   *    所以这里挂一次就够，模式判断放在事件回调里做。
   */
  #bindWheel(doc: Document | undefined): void {
    if (!doc || this.#wheelDoc === doc) return;
    this.#wheelDoc = doc;
    doc.addEventListener('wheel', this.#onWheel, { passive: false });
  }

  #onWheel = (e: WheelEvent): void => {
    // 滚动模式交给内核的原生滚动，不拦截
    if (this.#settings?.flow !== 'paginated') return;

    // 必须 preventDefault，否则列布局下画面会来回弹
    e.preventDefault();

    const now = Date.now();
    if (now < this.#wheelUnlockAt) return;

    // deltaMode 可能是像素(0)/行(1)/页(2)，先统一折算成像素再累加
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    this.#wheelAccum += e.deltaY * unit;

    if (Math.abs(this.#wheelAccum) < WHEEL_STEP) return;

    const forward = this.#wheelAccum > 0;
    this.#wheelAccum = 0;
    this.#wheelUnlockAt = now + WHEEL_COOLDOWN_MS;
    void (forward ? this.next() : this.prev());
  };

  /* ---------------------------------------------------------------- 事件 */

  onRelocate(fn: RelocateListener): () => void {
    this.#relocateListeners.add(fn);
    return () => this.#relocateListeners.delete(fn);
  }

  onLoad(fn: LoadListener): () => void {
    this.#loadListeners.add(fn);
    return () => this.#loadListeners.delete(fn);
  }
}
