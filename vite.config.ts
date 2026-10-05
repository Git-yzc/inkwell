import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Tauri 在开发时会把宿主地址塞进这个变量（Android 真机调试用）。
const host = process.env.TAURI_DEV_HOST;

const root = fileURLToPath(new URL('.', import.meta.url));

/* --------------------------------------------------------------------- PDF */

/** foliate-js 自带的 pdf.js v5 及其资源（cmaps / standard_fonts / 层样式）所在目录。 */
const pdfjsVendorDir = path.resolve(root, 'packages/foliate-js/vendor/pdfjs');
/**
 * 产物里的资源目录名。
 *
 * ⚠️ 必须与 `foliate-js/pdf.js` 里 `pdfjsPath()` 拼出来的路径一致：
 * 我们把它改成基于 `document.baseURI` 的根相对路径，所以资源要落在 dist 根下的 `pdfjs/`。
 */
const PDFJS_PUBLIC_DIR = 'pdfjs';

/** 按扩展名给个像样的 Content-Type，dev server 用。 */
const MIME: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 统一分隔符后再比路径：Windows 上 Rollup 给的 id 是正斜杠，
 * 而 path.resolve() 给的是反斜杠，直接 `===` 永远不相等。
 */
const normalizePath = (p: string) => path.resolve(p).split(path.sep).join('/');

function foliatePdf(): Plugin {
  const realPdf = normalizePath(path.resolve(root, 'packages/foliate-js/pdf.js'));

  // ⚠️ 下面两条 URL_* 是**逐字**匹配 foliate-js/pdf.js 第 1 行：
  // `new URL(\`vendor/pdfjs/\${path}\`, import.meta.url)` 缺 './' 前缀，
  // Vite 会把它解析成非法 glob（Invalid glob: "vendor/pdfjs/*"）并让整个构建失败。
  const URL_FROM =
    'const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()';
  const URL_TO =
    'const pdfjsPath = path => new URL(`pdfjs/${path}`, document.baseURI).toString()';
  // PDF 的 book 原本不带 spread，内核会把相邻两页拼成跨页 —— 桌面宽屏下变成
  // 「左右各一页」，页码与进度跳着走（1、3、5…）。补成 'none' 才是一页一屏。
  const SPREAD_FROM = "const book = { rendition: { layout: 'pre-paginated' } }";
  const SPREAD_TO =
    "const book = { rendition: { layout: 'pre-paginated', spread: 'none' } }";

  return {
    name: 'inkwell:foliate-pdf',
    enforce: 'pre',

    transform(code, id) {
      if (normalizePath(id.split('?')[0] ?? id) !== realPdf) return null;
      if (!code.includes(URL_FROM) || !code.includes(SPREAD_FROM)) {
        throw new Error(
          'foliate-js/pdf.js 的结构与预期不符，vite.config.ts 的 foliatePdf() 适配需要复核',
        );
      }
      return { code: code.replace(URL_FROM, URL_TO).replace(SPREAD_FROM, SPREAD_TO), map: null };
    },

    // dev 下把 /pdfjs/* 直接指向 submodule 里的资源目录（产物走下面的 closeBundle）
    configureServer(server) {
      server.middlewares.use(`/${PDFJS_PUBLIC_DIR}`, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/').replace(/^\/+/, '');
        const target = path.resolve(pdfjsVendorDir, rel);
        if (!target.startsWith(pdfjsVendorDir)) {
          next();
          return;
        }
        const stream = createReadStream(target);
        stream.on('error', () => next());
        stream.on('open', () => {
          res.setHeader(
            'Content-Type',
            MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          );
          stream.pipe(res);
        });
      });
    },

    // 产物只发布 dist/，packages/ 里的文件不搬过去运行时取不到
    async closeBundle() {
      const dest = path.resolve(root, 'dist', PDFJS_PUBLIC_DIR);
      await fs.cp(pdfjsVendorDir, dest, { recursive: true });
      console.log('[inkwell] PDF 资源已复制到 dist/' + PDFJS_PUBLIC_DIR + '/');
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), foliatePdf()],

  resolve: {
    // tsconfig 的 paths 只有 tsc 认，打包器要单独告诉它一次。
    alias: {
      '@': path.resolve(root, 'src'),
      // foliate-js 以 submodule 形式放在 packages/ 下，用别名让它能被裸导入
      'foliate-js': path.resolve(root, 'packages/foliate-js'),
    },
  },

  // Tauri 自己会打印编译输出，别让 Vite 清屏把它盖掉。
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    // src-tauri 由 cargo 监听，Vite 不用管。
    watch: { ignored: ['**/src-tauri/**'] },
  },

  build: {
    // 两个平台都是现代内核：Windows 用 WebView2(Chromium)，Android 用系统 WebView(Chromium)。
    target: 'chrome110',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
