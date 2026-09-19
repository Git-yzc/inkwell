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
  THEMES,
  type BookInfo,
  type ReaderLocation,
  type RendererSettings,
  type TocItem,
} from './types';

/** 打开书籍时的可选项。 */
export interface OpenOptions {
  /** 上次读到的 CFI，用于恢复位置 */
  lastLocation?: string | null;
}

type RelocateListener = (loc: ReaderLocation) => void;
type LoadListener = (e: { index: number }) => void;

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

/** 按设置拼出注入书籍文档的 CSS。 */
function buildCss(s: RendererSettings): string {
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
  `;
}

export class ReaderEngine {
  #view: View;
  #settings: RendererSettings | null = null;
  #sectionCount = 0;
  #relocateListeners = new Set<RelocateListener>();
  #loadListeners = new Set<LoadListener>();
  #opened = false;

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
      const detail = (e as CustomEvent<{ index: number }>).detail;
      // 换章节时内核会重建文档，样式需要重新注入
      this.#applyRendererAttributes();
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
      renderer.setStyles?.(buildCss(s));
    }
  }

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
