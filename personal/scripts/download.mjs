/**
 * 砚池 (Inkwell) —— 通用下载器。
 *
 * 用法: node personal/scripts/download.mjs <url> <目标路径>
 *
 * 为什么不用 PowerShell 的 Invoke-WebRequest：
 * 本机经代理访问 https 时，Windows schannel 会报
 * SEC_E_NO_CREDENTIALS (0x8009030e) 导致下载全部失败；
 * 而 Node 自带 OpenSSL 并会自动读取系统代理，实测稳定可用。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const [url, dest] = process.argv.slice(2);
if (!url || !dest) {
  console.error('用法: node download.mjs <url> <目标路径>');
  process.exit(2);
}

const target = path.resolve(dest);
await mkdir(path.dirname(target), { recursive: true });

// 已存在且非空则跳过，保证脚本可反复运行。
try {
  const s = await stat(target);
  if (s.size > 0) {
    console.log('已存在，跳过下载: ' + target + '  (' + s.size + ' 字节)');
    process.exit(0);
  }
} catch {
  // 不存在，继续下载
}

console.log('下载: ' + url);
console.log('  -> ' + target);

const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error('下载失败: HTTP ' + res.status + ' ' + res.statusText);
  process.exit(1);
}

const total = Number(res.headers.get('content-length') || 0);
let done = 0;
let lastPct = -1;

const body = Readable.fromWeb(res.body);
body.on('data', (chunk) => {
  done += chunk.length;
  if (total > 0) {
    const pct = Math.floor((done / total) * 100);
    if (pct >= lastPct + 10) {
      lastPct = pct;
      console.log(
        '  进度 ' +
          pct +
          '%  (' +
          Math.round(done / 1048576) +
          ' / ' +
          Math.round(total / 1048576) +
          ' MB)',
      );
    }
  }
});

try {
  await pipeline(body, createWriteStream(target));
} catch (e) {
  await rm(target, { force: true });
  console.error('写入失败: ' + e.message);
  process.exit(1);
}

const final = await stat(target);
if (total > 0 && final.size !== total) {
  console.error('大小不符：期望 ' + total + '，实际 ' + final.size);
  process.exit(1);
}
console.log('完成: ' + final.size + ' 字节');
