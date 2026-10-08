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

import { adaptAuthorColors } from './author-colors';
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
  /** 上次读到的 CFI，用于恢复位置（PDF 没有 CFI，固定为 null） */
  lastLocation?: string | null;
  /**
   * 上次读到的进度 0..1。
   *
   * PDF 没有可用的 CFI，只能靠它落回页码 —— 内核的 `sections` 一页一节、
   * 每节 size 相同，所以 `goToFraction` 能精确落到那一页。
   */
  lastFraction?: number | null;
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
/** 正文中间区域被双击（Android 上用来切换上下工具栏，见 REQ-2026-10-05-01）。 */
type ToggleBarsListener = () => void;

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

/** 双击判定的最大间隔（毫秒）：超过它两次点按各自独立。 */
const DOUBLE_TAP_MS = 320;
/** 双击允许的最大位移（像素）：手指落点总会飘一点，给个容差。 */
const DOUBLE_TAP_SLOP = 32;
/** 双击清掉选区后，多久之内忽略选区回调（免得顺手弹出批注操作栏）。 */
const DOUBLE_TAP_SELECTION_MUTE_MS = 600;

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

/**
 * 内核位置 → 我们自己的位置对象。
 *
 * `usePages` 为 true 时（固定版式：PDF / 漫画）一页就是一节，直接用页码；
 * 否则用内核按 `sizePerLoc` 折算出的全书位置（Kindle 式）。
 */
function toLocation(
  raw: FoliateLocation | null,
  fallbackSectionTotal: number,
  usePages: boolean,
): ReaderLocation {
  const label = raw?.tocItem?.label;
  const section = raw?.section;
  const current = usePages ? (section?.current ?? 0) + 1 : (raw?.location?.current ?? 0);
  const total = usePages ? (section?.total ?? fallbackSectionTotal) : (raw?.location?.total ?? 0);

  return {
    cfi: raw?.cfi ?? null,
    fraction: typeof raw?.fraction === 'number' ? raw.fraction : 0,
    sectionIndex: section?.current ?? 0,
    sectionTotal: section?.total ?? fallbackSectionTotal,
    chapterLabel: typeof label === 'string' && label.trim() ? label.trim() : null,
    positionCurrent: current,
    positionTotal: total,
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
  #toggleBarsListeners = new Set<ToggleBarsListener>();
  /** 固定版式（PDF / 漫画）：不套文字排版、不绑划词与下拉手势 */
  #fixedLayout = false;
  /** 已挂上双击监听的书籍文档（换章节会换文档，按文档去重） */
  #tapDoc: Document | null = null;
  #lastTap: { t: number; x: number; y: number } | null = null;
  /** 第一次点按时是否已有选区：有的话说明用户在划词，双击不响应（Q3） */
  #tapHadSelection = false;
  /** 在这个时刻之前忽略选区回调（双击清选区的余波） */
  #muteSelectionUntil = 0;
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
      const loc = toLocation(detail, this.#sectionCount, this.#fixedLayout);
      for (const fn of this.#relocateListeners) fn(loc);
    });

    this.#view.addEventListener('load', (e) => {
      const detail = (e as CustomEvent<{ doc?: Document; index: number }>).detail;
      // view.open() 在渲染之前就把 isFixedLayout 置好了，这里跟着同步，
      // 保证第一次 relocate 就用对位置口径。
      this.#fixedLayout = this.#view.isFixedLayout === true;
      // 换章节时内核会重建 iframe 文档，样式、滚轮与选区监听都要重新挂
      this.#applyRendererAttributes();
      this.#adaptAuthorColors(detail?.doc);
      this.#bindWheel(detail?.doc);
      this.#bindDoubleTap(detail?.doc);
      // 固定版式（PDF）本次不做批注：不绑划词与下拉手势，
      // 免得上层弹出注定存不下的批注操作栏（REQ-2026-10-05-04 Q11）。
      if (!this.#fixedLayout) {
        this.#bindSelection(detail?.doc);
        this.#bindPullDown(detail?.doc);
      }
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
    this.#fixedLayout = book?.rendition?.layout === 'pre-paginated';

    // 固定版式没有可用的 CFI（PDF 的 resolveCFI 根本没实现），
    // 传进去只会让内核走 CFI.parse 那条异常路径，所以一律不传。
    const last = this.#fixedLayout ? null : (opts.lastLocation ?? null);
    await this.#view.init({ lastLocation: last, showTextStart: !last });

    // PDF 等固定版式靠进度比例落回页码（一页一节，比例即页码）。
    // ⚠️ 必须先确认内核建了 sectionProgress：它就建在 splitTOCHref / getTOCFragment 都存在时
    // （见 view.js 的 open），少了它们 goToFraction 会直接抛错。
    const lastFraction = opts.lastFraction ?? null;
    const canLocateByFraction =
      typeof book?.splitTOCHref === 'function' && typeof book?.getTOCFragment === 'function';
    if (this.#fixedLayout && canLocateByFraction && lastFraction !== null && lastFraction > 0) {
      await this.#view.goToFraction(Math.min(1, Math.max(0, lastFraction)));
    }

    this.#opened = true;
    this.#applyRendererAttributes();
    // ⚠️ 这里必须补一次重画。
    //
    // setHighlights() 往往在 #opened 还是 false 的时候就跑完了 —— 那次重画会被
    // #drawHighlights 的守卫挡掉，而 open() 期间触发的 create-overlay 同样发生在
    // #opened 置位之前。不补这一次，重开书后高亮就不会出现在正文里。
    void this.#drawHighlights();

    return {
      title: pickText(book?.metadata?.title),
      author: pickText(book?.metadata?.author) ?? pickText(book?.metadata?.creator),
      language: pickText(book?.metadata?.language),
      toc,
      sectionCount: this.#sectionCount,
      fixedLayout: this.#fixedLayout,
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
    this.#unbindDoubleTap();
    this.#muteSelectionUntil = 0;
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
    this.#toggleBarsListeners.clear();
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

  /** 清掉正文里的选区（加完批注、双击切换工具栏后调用，免得浮层一直挂着）。 */
  clearSelection(): void {
    if (!this.#opened) return;
    try {
      this.#view.deselect();
    } catch {
      // 固定版式或文档已卸载时忽略：清选区失败不影响别的事
    }
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
    // 双击会顺带选中一个词（Android 的原生行为），刚被我们清掉，
    // 这段时间内的选区回调一律忽略，免得弹出批注操作栏。
    if (Date.now() < this.#muteSelectionUntil) return;
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

  /**
   * 取书籍第 1 页渲染出的封面图（目前只有 PDF 这类固定版式提供，见 Q9）。
   *
   * 只在内存里画一次，落盘与压缩由调用方决定；取不到就返回 null。
   */
  async getCoverBlob(): Promise<Blob | null> {
    const getCover = this.#view.book?.getCover;
    if (!this.#opened || typeof getCover !== 'function') return null;
    try {
      return await getCover.call(this.#view.book);
    } catch (e) {
      console.warn('渲染封面失败', e);
      return null;
    }
  }

  /* ---------------------------------------------------------------- 设置 */

  applySettings(settings: RendererSettings): void {
    this.#settings = settings;
    this.#applyRendererAttributes();
    // 主题换了，作者点名的字色要跟着重算（浅色主题下是「还原」）
    this.#adaptAuthorColors();
  }

  /**
   * 按当前阅读主题适配正文里作者点名的字色。
   *
   * 换主题、换章节都要重算：前者因为对比度基准变了，后者因为内核会重建书籍文档。
   * `doc` 传空时取当前正在渲染的文档 —— 内核的 `getContents()` 在分页渲染器下
   * 只返回这一份（见 paginator.js）。
   */
  #adaptAuthorColors(doc?: Document | null): void {
    const s = this.#settings;
    // 固定版式（PDF / 漫画）是整页位图，没有可调的文字颜色
    if (!s || this.#fixedLayout) return;
    const target = doc ?? this.#view.renderer?.getContents?.()[0]?.doc;
    if (!target) return;
    adaptAuthorColors(target, THEMES[s.theme].bg);
  }

  #applyRendererAttributes(): void {
    const s = this.#settings;
    const renderer = this.#view.renderer;
    if (!s || !renderer) return;

    renderer.setAttribute('flow', s.flow);
    // ⚠️ 必须带单位。内核把它原样塞进 CSS 变量 --_margin，再用于
    // `grid-template-rows: minmax(var(--_margin), 1fr)`。裸数字不是合法长度，
    // 那条声明会失效、整行塌掉 —— 表现为「页边距一旦不为 0，正文就缩成一小块」。
    // 内核自己的默认值就是 48px，且 #beforeRender 是 parseFloat，带 px 不受影响。
    renderer.setAttribute('margin', `${s.margin}px`);
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
    // 固定版式（PDF）本次不做书签，手势也就没有意义
    if (!doc || this.#fixedLayout || this.#pullDoc === doc) return;
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

  /* ------------------------------------------------------ 双击切换工具栏 */

  /**
   * 订阅「正文中间区域被双击」（REQ-2026-10-05-01）。
   *
   * 只在**触摸**双击时触发：Windows 桌面端本次不做这条（Q2）。
   * 左右两侧 18% 的翻页点按区在**外层文档**（覆盖在 iframe 之上），
   * 点按根本不会到达书籍文档，所以这里天然只在中间区域生效。
   */
  onToggleBars(fn: ToggleBarsListener): () => void {
    this.#toggleBarsListeners.add(fn);
    return () => this.#toggleBarsListeners.delete(fn);
  }

  /** 给书籍文档挂双击判定。换章节会换文档，用 #tapDoc 去重。 */
  #bindDoubleTap(doc: Document | undefined): void {
    if (!doc || this.#tapDoc === doc) return;
    this.#unbindDoubleTap();
    this.#tapDoc = doc;
    // 只读不拦截：不给 passive:false，避免影响滚动与选词
    doc.addEventListener('pointerup', this.#onTapForDoubleTap, { passive: true });
  }

  #unbindDoubleTap(): void {
    this.#tapDoc?.removeEventListener('pointerup', this.#onTapForDoubleTap);
    this.#tapDoc = null;
    this.#lastTap = null;
    this.#tapHadSelection = false;
  }

  /**
   * 用两次 pointerup 自己拼双击，而不是用 dblclick：
   * Android WebView 在关掉缩放后并不保证派发 dblclick，自己判定更稳。
   *
   * 关于选区：Android 上双击正文会顺带选中一个词（原生行为）。
   * 若第一次点按时**已经**有选区，说明用户在划词，按 Q3 直接不响应；
   * 否则把这次双击造成的选区清掉再切换工具栏 —— 否则会「工具栏和批注栏一起弹」。
   */
  #onTapForDoubleTap = (e: PointerEvent): void => {
    // 鼠标不参与：双击呼出工具栏本次只做 Android（Q2）
    if (e.pointerType === 'mouse') return;

    const now = Date.now();
    const last = this.#lastTap;
    const nearby =
      last !== null &&
      now - last.t <= DOUBLE_TAP_MS &&
      Math.abs(e.clientX - last.x) <= DOUBLE_TAP_SLOP &&
      Math.abs(e.clientY - last.y) <= DOUBLE_TAP_SLOP;

    if (!nearby) {
      // 第一下：记下它以及「这时是否已在划词」
      this.#lastTap = { t: now, x: e.clientX, y: e.clientY };
      this.#tapHadSelection = this.#hasSelection();
      return;
    }

    this.#lastTap = null;
    if (this.#tapHadSelection) return; // 划词中不响应（Q3）

    if (this.#hasSelection()) {
      this.#muteSelectionUntil = now + DOUBLE_TAP_SELECTION_MUTE_MS;
      this.clearSelection();
    }
    for (const fn of this.#toggleBarsListeners) fn();
  };

  #hasSelection(): boolean {
    const sel = this.#tapDoc?.defaultView?.getSelection();
    return !!sel && !sel.isCollapsed;
  }

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
