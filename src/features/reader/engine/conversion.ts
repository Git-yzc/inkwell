/**
 * 简繁转换（REQ-2026-11-22-02）。
 *
 * 用 opencc-js（MIT AND Apache-2.0）在**渲染后的 DOM 文本节点**上做转换，不改原书文件，
 * 也不改数据库里的 CFI。之所以能这么做：
 *
 * - OpenCC 的通用繁简字典（TSPhrases / STPhrases / TSCharacters / STCharacters）
 *   在 **Unicode 码点长度**上逐条等长（实测 0 条不同）；只有极少数兼容表意文字
 *   会因代理对在 UTF-16 上差 1 个 code unit；
 * - 绝大多数文本转换后长度不变，foliate 的 CFI 字符偏移仍然对得上。
 * - 为万无一失，`convertPreservingLength` 会在长度真的变化时**放弃这个文本节点**
 *   （保留原文），宁可少转一句，也不让书签 / 批注的 CFI 错位。
 *
 * 换章节时内核会重建文档，引擎在 load 事件里重新调用 `applyConversion`；
 * 切换设置时用 `restoreConversion` + 重新转换，原文备份在 WeakMap 里，文档销毁即释放。
 */
import OpenCC from 'opencc-js';

import type { ConversionMode } from './types';

type Converter = (text: string) => string;

let t2s: Converter | null = null;
let s2t: Converter | null = null;

/** 懒创建转换器：opencc-js 的字典初始化不便宜，没开这个功能就不该付这笔钱。 */
function converter(mode: Exclude<ConversionMode, 'off'>): Converter {
  if (mode === 't2s') {
    t2s ??= OpenCC.Converter({ from: 't', to: 'cn' });
    return t2s;
  }
  s2t ??= OpenCC.Converter({ from: 'cn', to: 't' });
  return s2t;
}

/** 正文里是否含汉字（不含汉字的节点直接跳过，省掉大量无意义的转换）。 */
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 每个文档的「原文备份」：Text -> 转换前的 nodeValue。 */
const originalsByDoc = new WeakMap<Document, Map<Text, string>>();

/**
 * 显示用转换（搜索结果摘录等）。这里**不**要求长度不变 —— 摘录不参与 CFI 定位。
 */
export function convertDisplay(text: string, mode: ConversionMode): string {
  if (mode === 'off' || !text) return text;
  try {
    return converter(mode)(text);
  } catch (e) {
    console.warn('简繁转换失败', e);
    return text;
  }
}

/** 把用户的搜索词转成「原文那一侧」的写法，否则简繁互搜永远搜不到。 */
export function convertQueryForSource(query: string, mode: ConversionMode): string {
  if (mode === 'off') return query;
  // 显示繁体（s2t）时原文是简体，查询要转成简体；显示简体（t2s）时反过来。
  return convertDisplay(query, mode === 't2s' ? 's2t' : 't2s');
}

/** 长度不变的转换；长度变了就退回原文，保住 CFI。 */
function convertPreservingLength(text: string, mode: ConversionMode): string {
  if (mode === 'off' || !text || !CJK_RE.test(text)) return text;
  const converted = convertDisplay(text, mode);
  return converted.length === text.length ? converted : text;
}

/**
 * 给当前书籍文档套用转换。
 *
 * @returns 是否真的改动了文本（调用方据此决定要不要让内核重新分页）
 */
export function applyConversion(doc: Document | null | undefined, mode: ConversionMode): boolean {
  if (!doc?.body) return false;

  if (mode === 'off') return restoreConversion(doc);

  let originals = originalsByDoc.get(doc);
  if (!originals) {
    originals = new Map();
    originalsByDoc.set(doc, originals);
  }

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // 脚本 / 样式 / 代码块不转换；SVG / MathML 里的文字也不动
      if (parent.closest('script, style, noscript, svg, math')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let changed = false;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const current = node.nodeValue ?? '';
    if (current && CJK_RE.test(current)) {
      const original = originals.get(node) ?? current;
      const converted = convertPreservingLength(original, mode);
      if (converted !== current) {
        node.nodeValue = converted;
        changed = true;
      }
      if (converted !== original) originals.set(node, original);
    }
    node = walker.nextNode() as Text | null;
  }
  return changed;
}

/** 还原这个文档里被转换过的文本。 */
export function restoreConversion(doc: Document | null | undefined): boolean {
  const originals = doc ? originalsByDoc.get(doc) : undefined;
  if (!doc || !originals) return false;

  for (const [node, original] of originals) {
    if (node.nodeValue !== original) node.nodeValue = original;
    originals.delete(node);
  }
  originalsByDoc.delete(doc);
  return true;
}
