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

    /**
     * 加一条批注。`annotation.value` 是 CFI；`remove` 为 true 时是删除。
     *
     * 内核只负责解析 CFI 与取 range，**实际怎么画由我们决定** ——
     * 它会发 `draw-annotation` 事件，把 draw 回调交回来（见 engine/index.ts）。
     */
    addAnnotation(
      annotation: { value: string; [k: string]: unknown },
      remove?: boolean,
    ): Promise<{ index: number; label: string }>;
    deleteAnnotation(annotation: { value: string }): Promise<{ index: number; label: string }>;

    /** 清掉所有书籍文档里的选区。 */
    deselect(): void;

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

declare module 'foliate-js/overlayer.js' {
  /**
   * 批注/搜索结果的绘制层。
   *
   * ⚠️ 它的 SVG 挂在**应用文档**里（paginator 把它 append 到自己的容器上），
   * 不是书籍 iframe 里 —— 所以控制它外观的 CSS 变量要写在 globals.css，
   * 写进注入书籍的样式里是没用的。
   */
  export class Overlayer {
    element: SVGElement;
    add(
      key: string,
      range: Range | ((root: Node) => Range),
      draw: DrawFunction,
      options?: Record<string, unknown>,
    ): void;
    remove(key: string): void;
    redraw(): void;
    hitTest(point: { x: number; y: number }): [string, Range] | [];

    /** 半透明色块，颜色由 options.color 指定。 */
    static highlight(rects: DOMRectList, options?: { color?: string }): SVGGElement;
    static underline(rects: DOMRectList, options?: { color?: string; width?: number }): SVGGElement;
    static squiggly(rects: DOMRectList, options?: { color?: string; width?: number }): SVGGElement;
    static outline(
      rects: DOMRectList,
      options?: { color?: string; width?: number; radius?: number },
    ): SVGGElement;
  }

  export type DrawFunction = (rects: DOMRectList, options?: Record<string, unknown>) => SVGElement;
}
