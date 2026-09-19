import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Tauri 在开发时会把宿主地址塞进这个变量（Android 真机调试用）。
const host = process.env.TAURI_DEV_HOST;

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * 把 foliate-js 的 PDF 模块换成我们自己的桩。
 *
 * foliate-js/pdf.js 里的 `new URL(\`vendor/pdfjs/\${path}\`, import.meta.url)`
 * 缺 './' 前缀，Vite 会判定为非法 glob 并让**整个构建失败**。
 * 这里在解析阶段就把该模块替换掉，submodule 本身保持原样。
 * 详见 src/features/reader/engine/pdf-stub.js 的注释。
 */
function foliatePdfStub(): Plugin {
  const realPdf = path.resolve(root, 'packages/foliate-js/pdf.js');
  const stub = path.resolve(root, 'src/features/reader/engine/pdf-stub.js');

  return {
    name: 'inkwell:foliate-pdf-stub',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      const from = importer.split('?')[0] ?? importer;
      if (path.resolve(path.dirname(from), source) === realPdf) return stub;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), foliatePdfStub()],

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
