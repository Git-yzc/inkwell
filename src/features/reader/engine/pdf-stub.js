/**
 * foliate-js 的 PDF 模块桩。
 *
 * 为什么需要它：
 * foliate-js 的 pdf.js 第 1 行写的是
 *     new URL(\`vendor/pdfjs/\${path}\`, import.meta.url)
 * 缺了 './' 前缀，Vite 会把它解析成一个不合法的 glob 直接报错：
 *     [vite:import-glob] Invalid glob: "vendor/pdfjs/*"
 * 于是**整个前端构建失败**，哪怕我们根本不看 PDF。
 *
 * 而且 PDF 真正可用还需要把 pdf.worker.mjs、cmaps、standard_fonts
 * 作为静态资源发布出去（foliate-js 上游是靠 rollup 脚本拷贝的），
 * 这属于另一块工作。
 *
 * 因此阶段 1 先只做 EPUB：在 vite.config.ts 里把 pdf.js 指到这里，
 * 既让构建通过，又给出明确的中文提示，而不是让用户遇到一个费解的报错。
 *
 * ⚠️ 注意：这是**我们自己的**适配代码，submodule 保持原样未改动。
 */

export const makePDF = async () => {
  throw new Error('暂不支持 PDF：阶段 1 先做 EPUB，需要时再接入 PDF 渲染');
};
