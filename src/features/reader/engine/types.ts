/**
 * 阅读器引擎对外暴露的**稳定接口**。
 *
 * foliate-js 官方 README 明说 API 随时可能变，所以 UI 层只依赖这里的类型；
 * 升级内核时只需要改 engine/index.ts 一个文件。
 */

/** 当前阅读位置。 */
export interface ReaderLocation {
  /** EPUB CFI 定位串，用于精确恢复位置 */
  cfi: string | null;
  /** 全书进度 0..1 */
  fraction: number;
  /** 当前章节序号（从 0 开始） */
  sectionIndex: number;
  sectionTotal: number;
  /** 当前章节标题，取不到则为 null */
  chapterLabel: string | null;
  /** 全书剩余阅读时间（秒），内核估算不出时为 null */
  remainingSeconds: number | null;
}

/** 目录项。subitems 与内核结构保持一致，便于直接递归渲染。 */
export interface TocItem {
  /** 归一化时分配的稳定 id，用作 React key（目录项可能 href 重复） */
  id: string;
  label: string;
  href: string;
  subitems: TocItem[];
}

/** 打开书籍后拿到的静态信息。 */
export interface BookInfo {
  /** 内核解析出的书名（可能为空，UI 应优先用书库里的标题） */
  title: string | null;
  /** 语言标签，用于判断是否需要 CJK 排版处理 */
  language: string | null;
  toc: TocItem[];
  sectionCount: number;
  /** 固定版式（漫画、画册）为 true，此时不套用文字排版设置 */
  fixedLayout: boolean;
}

export type FlowMode = 'paginated' | 'scrolled';
export type ThemeKey = 'light' | 'sepia' | 'dark';
/** 中文排版的开关方式：auto = 按书籍自身的语言自动判断。 */
export type CjkMode = 'auto' | 'on' | 'off';

/** 阅读外观设置。 */
export interface RendererSettings {
  /** 正文字号，单位 px */
  fontSize: number;
  /** 行高倍数 */
  lineHeight: number;
  /** 页边距，单位 px */
  margin: number;
  /** 正文字体族；空字符串表示沿用书籍自带字体 */
  fontFamily: string;
  theme: ThemeKey;
  flow: FlowMode;
  /** 分栏数上限，双栏适合宽屏 */
  maxColumnCount: number;
  /** 中文排版（首行缩进、行首禁则、中西文间距） */
  cjkTypography: CjkMode;
}

export const DEFAULT_SETTINGS: RendererSettings = {
  fontSize: 18,
  lineHeight: 1.75,
  margin: 40,
  fontFamily: '',
  theme: 'light',
  flow: 'paginated',
  maxColumnCount: 1,
  cjkTypography: 'auto',
};

/**
 * 交给渲染引擎的高亮。
 *
 * 引擎只负责「画出来」，业务字段（笔记、章节、时间）都留在 api.ts 的类型里。
 * 书签不需要画，所以不往这里传。
 */
export interface HighlightView {
  /** EPUB CFI（range）。foliate 拿它当 overlayer 的 key，同一 CFI 重复添加会覆盖 */
  cfi: string;
  /** 高亮色名 */
  color: string | null;
}

/**
 * 正文里当前选中的一段文字。
 *
 * `rect` 用的是**顶层视口**坐标（已把书籍 iframe 的位置加回去），
 * UI 拿它减去正文容器的位置即可定位浮层。
 */
export interface SelectionInfo {
  text: string;
  cfi: string;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * 高亮色名 → 色值。
 *
 * Overlayer 会再叠一层透明度（`--overlayer-highlight-opacity`，见 globals.css），
 * 所以这里给饱和色即可。色值只活在前端，库里存的是色名。
 *
 * ⚠️ 色名清单与 Rust 侧 `annotation::COLORS`、`api.ts` 的 `HighlightColor` 三处对应，
 * 加颜色时一起改。
 */
export const HIGHLIGHT_COLORS = {
  yellow: '#ffd400',
  green: '#3ecf6a',
  blue: '#3a9bff',
  pink: '#ff6fb5',
} as const;

export type HighlightColorName = keyof typeof HIGHLIGHT_COLORS;

/** 色名 → 色值；未知色名回落到黄色（库里的旧数据或将来加的颜色都可能对不上）。 */
export function highlightColor(name: string | null | undefined): string {
  if (name && name in HIGHLIGHT_COLORS) return HIGHLIGHT_COLORS[name as HighlightColorName];
  return HIGHLIGHT_COLORS.yellow;
}

/** 色块的展示顺序（工具栏按这个顺序排）。 */
export const HIGHLIGHT_COLOR_ORDER: HighlightColorName[] = ['yellow', 'green', 'blue', 'pink'];

/** 中文排版开关的可选项，供设置面板渲染。 */
export const CJK_MODE_CHOICES: { label: string; value: CjkMode; hint: string }[] = [
  { label: '自动', value: 'auto', hint: '按书籍语言判断，中文书才套用' },
  { label: '开', value: 'on', hint: '任何书都套用中文排版' },
  { label: '关', value: 'off', hint: '沿用书籍自带排版' },
];

/** 主题配色。正文容器与页面背景都取这里的值，保证观感一致。 */
export const THEMES: Record<ThemeKey, { name: string; bg: string; fg: string; muted: string }> = {
  light: { name: '浅色', bg: '#ffffff', fg: '#1c1c1c', muted: '#666666' },
  sepia: { name: '羊皮纸', bg: '#f6ecd8', fg: '#3b3226', muted: '#7a6a52' },
  dark: { name: '深色', bg: '#141414', fg: '#cfcfcf', muted: '#8a8a8a' },
};

/** 可选字体。第一项为空值 = 使用书籍自带字体。 */
export const FONT_CHOICES: { label: string; value: string }[] = [
  { label: '书籍自带', value: '' },
  { label: '宋体 / 衬线', value: '"Source Han Serif SC", "Songti SC", SimSun, Georgia, serif' },
  {
    label: '黑体 / 无衬线',
    value: '"Source Han Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif',
  },
  { label: '楷体', value: 'KaiTi, "Kaiti SC", STKaiti, serif' },
];
