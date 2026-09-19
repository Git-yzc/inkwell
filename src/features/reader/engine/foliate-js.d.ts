/**
 * foliate-js 是纯 JavaScript 且不带类型声明，这里只声明我们实际用到的那部分接口。
 *
 * 保持**最小**：声明的越多，将来内核改 API 时我们要跟着改的地方就越多。
 * 完整的类型安全感由 engine/index.ts 那一层负责包装。
 */
declare module 'foliate-js/view.js' {
  /** foliate-js 的 View 是一个自定义元素（<foliate-view>）。 */
  export class View extends HTMLElement {
    /** book 可以是 URL 字符串、File/Blob，或已解析的 book 对象。 */
    open(book: string | File | Blob): Promise<void>;

    /** 初始化阅读位置。lastLocation 为 CFI 串。 */
    init(opts?: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>;

    close(): void;

    goTo(target: string | number | { index: number; anchor?: unknown }): Promise<void>;
    goToFraction(fraction: number): Promise<void>;
    next(distance?: number): Promise<void>;
    prev(distance?: number): Promise<void>;
    goLeft(): Promise<void>;
    goRight(): Promise<void>;

    getCFI(index: number, range: Range): string;
    resolveNavigation(target: string | number): Promise<{ index: number; anchor: unknown } | null>;
    getSectionFractions(): number[];

    /** 已打开的书籍对象：metadata / toc / sections / dir 等。 */
    book: FoliateBook | null;
    /** 实际渲染器（paginator 或 fixed-layout）。 */
    renderer: FoliateRenderer | null;
    lastLocation: FoliateLocation | null;
  }

  export interface FoliateBook {
    dir?: string;
    metadata?: Record<string, unknown>;
    toc?: FoliateTocItem[];
    sections?: { id?: string; linear?: string; size?: number }[];
    rendition?: { layout?: string };
  }

  export interface FoliateTocItem {
    label?: string;
    href?: string;
    subitems?: FoliateTocItem[];
  }

  export interface FoliateLocation {
    fraction?: number;
    cfi?: string;
    section?: { current: number; total: number };
    location?: { current: number; next: number; total: number };
    time?: { section?: number; total?: number };
    tocItem?: FoliateTocItem | null;
  }

  export interface FoliateRenderer extends HTMLElement {
    setStyles?: (css: string) => void;
  }
}
