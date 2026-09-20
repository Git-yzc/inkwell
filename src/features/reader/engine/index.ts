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
import type { FoliateLocation, FoliateTocItem, View } from 'foliate-js/view.js';

import {
  type BookInfo,
  type ReaderLocation,
  type RendererSettings,
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
  #opened = false;
  /** 已挂上滚轮监听的书籍文档；换章节会换文档，用它去重 */
  #wheelDoc: Document | null = null;
  #wheelAccum = 0;
  #wheelUnlockAt = 0;

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
      // 换章节时内核会重建 iframe 文档，样式和滚轮监听都要重新挂
      this.#applyRendererAttributes();
      this.#bindWheel(detail?.doc);
      for (const fn of this.#loadListeners) fn({ index: detail?.index ?? 0 });
    });
  }

  async open(absPath: string, opts: OpenOptions = {}): Promise<BookInfo> {
    const file = await loadBookFile(absPath);
    await this.#view.open(file);

    const book = this.#view.book;
    const toc = normalizeToc(book?.toc);
    this.#sectionCount = book?.sections?.length ?? 0;

    const last = opts.lastLocation ?? null;
    await this.#view.init({ lastLocation: last, showTextStart: !last });

    this.#opened = true;
    this.#applyRendererAttributes();

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
    try {
      this.#view.close();
    } catch {
      // 已经卸载过就忽略
    }
    this.#view.remove();
    this.#relocateListeners.clear();
    this.#loadListeners.clear();
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
