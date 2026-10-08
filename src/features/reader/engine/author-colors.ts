/**
 * 作者指定字色在当前**阅读主题**下的可读性适配。
 *
 * 背景：注入书籍文档的 CSS 只能把 `html / body` 的颜色改成主题色，而作者在正文里
 * 点名的颜色（如 `span.note { color: #4f74b0 }`）是**直接声明在元素上**的，
 * 优先级天然高过继承来的主题色 —— 于是深色主题下出现「深蓝字压在黑底上」，
 * 用户看到的就是「换了夜间模式，这些有色的字还是原来那个颜色」。
 *
 * 书籍自己或许写了 `@media (prefers-color-scheme: dark)` 的备选色，但那条媒体查询
 * 看的是**系统**深浅，不是我们在设置里选的阅读主题，指望不上（样章的 style.css 正是如此）。
 *
 * 做法：扫一遍正文，只挑「颜色不是继承来的」元素（继承来的计算色等于父元素），
 * 算出它与**实际背景**的对比度；不达标的按**色相不变、只调明度**的方式提到可读为止。
 * 作者想表达的色差（注文蓝、白话棕）因此保留，而不是一律压成灰字。
 */

/** 低于这个对比度（WCAG AA 正文）就算「看不清」，要动手调。 */
const MIN_CONTRAST = 4.5;
/** 调到这个对比度（WCAG AAA）为止，避免刚好卡在阈值上发灰。 */
const TARGET_CONTRAST = 7;

type Rgb = [number, number, number];

/**
 * 我们写进书籍文档的内联色备份（值 = 元素原本的 `style.color`，空串表示原本没有）。
 *
 * 用 WeakMap：文档被内核换掉后条目随之释放，不会越攒越多。
 */
const originalColors = new WeakMap<Element, string>();

const RGB_RE = /^rgba?\(([^)]+)\)$/;

/** 解析 `getComputedStyle` 给出的 `rgb()/rgba()`；完全透明或解析失败返回 null。 */
function parseRgb(value: string): Rgb | null {
  const match = RGB_RE.exec(value.trim());
  const inner = match?.[1];
  if (!inner) return null;
  const parts = inner
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined) return null;
  if (![r, g, b].every((n) => Number.isFinite(n))) return null;
  // 作者写了 transparent / alpha:0 就不算「有色字」
  if (parts.length > 3 && parts[3] === 0) return null;
  return [r, g, b];
}

/** sRGB 相对亮度（WCAG 定义）。 */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 两色的对比度（1 ~ 21）。 */
function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** RGB → HSL，h / s / l 都是 0..1。 */
function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

/** HSL（0..1）→ RGB（0..255）。 */
function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

function toCss([r, g, b]: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * 把颜色调到与背景至少 TARGET_CONTRAST 的对比度：**色相与饱和度不变，只推明度**。
 *
 * 背景暗就往亮里推、背景亮就往暗里推，二分找到「刚好够亮 / 够暗」的那个明度，
 * 因此颜色不会被推过头（深色主题下不会变成纯白）。
 */
function toReadable(color: Rgb, bg: Rgb): Rgb {
  const [h, s, l] = rgbToHsl(color);
  const towardLight = luminance(bg) < 0.5;
  const fixed = towardLight ? 1 : 0;
  if (l === fixed) return color;

  // 二分：亮度沿 fixed 方向单调变化，对比度随之单调上升
  let lo = l;
  let hi = fixed;
  for (let i = 0; i < 18; i += 1) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(hslToRgb(h, s, mid), bg) >= TARGET_CONTRAST) hi = mid;
    else lo = mid;
  }
  return hslToRgb(h, s, hi);
}

/** 元素自己的背景色（透明则往祖先找）；都没有就用主题背景。 */
function effectiveBackground(el: Element, fallback: Rgb): Rgb {
  const view = el.ownerDocument.defaultView;
  if (!view) return fallback;
  let node: Element | null = el;
  while (node) {
    const bg = parseRgb(view.getComputedStyle(node).backgroundColor);
    if (bg) return bg;
    node = node.parentElement;
  }
  return fallback;
}

/** 元素子树里有没有可见文字（没有就不必为它算颜色）。 */
function hasText(el: Element): boolean {
  return (el.textContent ?? '').trim().length > 0;
}

/**
 * 按当前主题适配正文里的作者字色。可重复调用：每次先还原上一次写进去的内联色，
 * 再从**作者原始颜色**重新计算（否则换回浅色主题时会拿上一次的浅色接着算，越算越白）。
 *
 * `background` 是当前阅读主题的正文底色（`THEMES[...].bg`）。
 */
export function adaptAuthorColors(doc: Document, background: string): void {
  const view = doc.defaultView;
  const body = doc.body;
  if (!view || !body) return;

  const themeBg = parseRgb(background) ?? [255, 255, 255];

  // 1) 先还原：把我们上一次写进去的内联 color 撤掉
  for (const el of body.querySelectorAll<HTMLElement>('*')) {
    if (!originalColors.has(el)) continue;
    const original = originalColors.get(el) ?? '';
    if (original) el.setAttribute('style', original);
    else el.removeAttribute('style');
    originalColors.delete(el);
  }

  // 2) 再适配：只处理「颜色不是继承来的」元素
  const style = view.getComputedStyle.bind(view);
  for (const el of body.querySelectorAll<HTMLElement>('*')) {
    const color = parseRgb(style(el).color);
    if (!color) continue;
    const parent = el.parentElement;
    // 计算色等于父元素 → 这个颜色是继承来的，跟着父元素一起变即可
    if (parent && style(parent).color === style(el).color) continue;
    if (!hasText(el)) continue;

    const bg = effectiveBackground(el, themeBg);
    if (contrastRatio(color, bg) >= MIN_CONTRAST) continue;

    // 原来的 style 属性整串存下来（正文里带 style 的元素极少），还原时原样写回
    originalColors.set(el, el.getAttribute('style') ?? '');
    // 用 !important：作者样式里也可能带 !important，内联 + important 才一定压得住
    el.style.setProperty('color', toCss(toReadable(color, bg)), 'important');
  }
}
