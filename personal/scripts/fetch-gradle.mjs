/**
 * Pre-download the Gradle distribution required by the Android wrapper.
 *
 * Why: Gradle's wrapper downloads gradle-8.14.3-bin.zip through Java's
 * HttpURLConnection, which cannot get through the local proxy here
 * ("Read timed out"). Node can, so we fetch it and drop it exactly where
 * the wrapper expects it.
 *
 * Usage: node personal/scripts/fetch-gradle.mjs
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const VERSION = '8.14.3';
const DIST_URL = 'https://services.gradle.org/distributions/gradle-' + VERSION + '-bin.zip';
/**
 * 取得可用的 HTTP 代理。
 *
 * Windows 的代理设置存在注册表里，Node 与 Java 都不会自动读取。
 * 这里主动探测一次，顺序为：
 *   1. INKWELL_PROXY / HTTPS_PROXY / HTTP_PROXY 环境变量
 *   2. Windows 系统代理（注册表 Internet Settings）
 *   3. 都没有则直连
 * 返回值形如 { host, port }，直连时为 null。
 */
function detectProxy() {
  let raw = process.env.INKWELL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';

  if (!raw && process.platform === 'win32') {
    try {
      raw = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';" +
            '$v=Get-ItemProperty -Path $k -ErrorAction SilentlyContinue;' +
            'if($v.ProxyEnable -eq 1){$v.ProxyServer}',
        ],
        { encoding: 'utf8' },
      ).trim();
    } catch {
      // 读不到就直连
    }
  }

  if (!raw) return null;

  const withScheme = raw.includes('://') ? raw : 'http://' + raw;
  try {
    const u = new URL(withScheme);
    return { host: u.hostname, port: Number(u.port || 80) };
  } catch {
    return null;
  }
}

const PROXY = detectProxy();

const home = process.env.USERPROFILE;
if (!home) {
  console.error('no USERPROFILE');
  process.exit(1);
}

const distDir = path.join(home, '.gradle', 'wrapper', 'dists', 'gradle-' + VERSION + '-bin');

// The wrapper unpacks into a hash-named subdirectory next to the zip.
await mkdir(distDir, { recursive: true });
const entries = await readdir(distDir, { withFileTypes: true });
let sub = entries.find((e) => e.isDirectory());
if (!sub) {
  const { createHash } = await import('node:crypto');
  const md5 = createHash('md5').update(DIST_URL).digest('hex');
  const name = Buffer.from(md5).toString('base64').replace(/[/+=]/g, '').slice(0, 16);
  await mkdir(path.join(distDir, name), { recursive: true });
  sub = { name };
}
const target = path.join(distDir, sub.name, 'gradle-' + VERSION + '-bin.zip');

try {
  const s = await stat(target);
  if (s.size > 100 * 1024 * 1024) {
    console.log('already downloaded: ' + Math.round(s.size / 1048576) + ' MB');
    process.exit(0);
  }
} catch {
  /* not present */
}

/**
 * Minimal HTTPS-over-proxy GET. Node does not honour HTTP(S)_PROXY by itself,
 * and undici's ProxyAgent is not a dependency here, so we open the tunnel
 * manually and hand the socket to TLS.
 */
function openTls(targetUrl) {
  const u = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(PROXY_PORT, PROXY_HOST, () => {
      socket.write(
        'CONNECT ' +
          u.hostname +
          ':443 HTTP/1.1\r\n' +
          'Host: ' +
          u.hostname +
          ':443\r\n' +
          'Connection: keep-alive\r\n\r\n',
      );
    });
    socket.once('error', reject);
    socket.once('data', (chunk) => {
      const head = chunk.toString('latin1');
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        socket.destroy();
        reject(new Error('proxy CONNECT failed: ' + head.split('\r\n')[0]));
        return;
      }
      const sep = chunk.indexOf('\r\n\r\n');
      const rest = sep >= 0 ? chunk.subarray(sep + 4) : Buffer.alloc(0);
      socket.pause();
      if (rest.length) socket.unshift(rest);

      const tls = tlsConnect({ socket, servername: u.hostname }, () => {
        tls.write(
          'GET ' +
            u.pathname +
            u.search +
            ' HTTP/1.1\r\n' +
            'Host: ' +
            u.hostname +
            '\r\n' +
            'User-Agent: node\r\n' +
            'Accept: */*\r\n' +
            'Connection: close\r\n\r\n',
        );
      });
      tls.once('error', reject);
      resolve(tls);
    });
  });
}

/** Read only the response head, leaving the remaining bytes for the body. */
function readHead(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      socket.off('data', onData);
      const lines = buf.subarray(0, sep).toString('latin1').split('\r\n');
      const status = Number(lines[0].split(' ')[1]);
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const rest = buf.subarray(sep + 4);
      if (rest.length) socket.unshift(rest);
      resolve({ status, headers });
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

console.log('downloading ' + DIST_URL);
console.log('  via proxy ' + PROXY_HOST + ':' + PROXY_PORT);

let current = DIST_URL;
let body = null;
let contentLength = 0;

for (let hop = 0; hop < 6; hop++) {
  const socket = await openTls(current);
  const head = await readHead(socket);

  if (head.status >= 300 && head.status < 400 && head.headers.location) {
    socket.destroy();
    current = new URL(head.headers.location, current).toString();
    console.log('  redirect ' + head.status + ' -> ' + current.slice(0, 80));
    continue;
  }
  if (head.status !== 200) {
    socket.destroy();
    console.error('HTTP ' + head.status + ' for ' + current);
    process.exit(1);
  }
  body = socket;
  contentLength = Number(head.headers['content-length'] || 0);
  break;
}

if (!body) {
  console.error('too many redirects');
  process.exit(1);
}

let done = 0,
  last = -1;
body.on('data', (c) => {
  done += c.length;
  if (contentLength > 0) {
    const pct = Math.floor((done / contentLength) * 100);
    if (pct >= last + 10) {
      last = pct;
      console.log(
        '  ' +
          pct +
          '%  (' +
          Math.round(done / 1048576) +
          '/' +
          Math.round(contentLength / 1048576) +
          ' MB)',
      );
    }
  }
});

try {
  await pipeline(body, createWriteStream(target));
} catch (e) {
  await rm(target, { force: true });
  console.error('write failed: ' + e.message);
  process.exit(1);
}

// The wrapper only trusts an unpacked distribution when the .ok marker exists.
await writeFile(target + '.ok', '');
const s = await stat(target);
if (contentLength > 0 && s.size !== contentLength) {
  console.error('size mismatch: expected ' + contentLength + ', got ' + s.size);
  process.exit(1);
}
console.log('done: ' + Math.round(s.size / 1048576) + ' MB -> ' + target);
