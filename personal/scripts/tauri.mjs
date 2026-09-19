/**
 * 砚池 (Inkwell) —— Tauri CLI 包装器。
 *
 * 为什么不直接用 @tauri-apps/cli/tauri.js？
 * 那个脚本靠 process.argv[0] 的文件名来判断宿主（node / electron / bun…），
 * 名字对不上时它会把 argv[0] 当成子命令塞回去，于是报
 * "error: unrecognized subcommand 'D:\...\xxx.exe'"。
 * 本包装器不猜宿主，直接把参数原样转交给 CLI，因此在任何环境下都能用。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = require(path.join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'main.js'));

cli.run(process.argv.slice(2), 'inkwell tauri').catch((err) => {
  cli.logError(err.message);
  process.exit(1);
});
