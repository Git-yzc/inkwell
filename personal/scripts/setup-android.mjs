/**
 * 砚池 (Inkwell) —— Android SDK 自动安装（Windows）。
 *
 * 做四件事：
 *   1. 下载并解压 Android command-line-tools
 *   2. 用 sdkmanager 安装 platform-tools / platforms / build-tools / NDK
 *   3. 写入 ANDROID_HOME、NDK_HOME 等用户环境变量
 *   4. 给 Rust 添加四个 Android 交叉编译目标
 *
 * 全部幂等，可反复运行。
 *
 * 用法: node personal/scripts/setup-android.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const CMDLINE_TOOLS_URLS = [
  'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip',
];

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  console.error('未找到 LOCALAPPDATA');
  process.exit(1);
}

const sdkRoot = path.join(localAppData, 'Android', 'Sdk');
const sdkmanager = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');

const log = (m) => console.log(m);
const ok = (m) => console.log('  [OK]   ' + m);
const info = (m) => console.log('         ' + m);
const bad = (m) => console.error('  [FAIL] ' + m);

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  log('下载: ' + url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  let done = 0,
    last = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    done += c.length;
    if (total > 0) {
      const pct = Math.floor((done / total) * 100);
      if (pct >= last + 20) {
        last = pct;
        log('  ' + pct + '%');
      }
    }
  });
  await pipeline(body, createWriteStream(dest));
}

/**
 * 取得可用的 HTTP 代理（形如 { host, port }，直连时为 null）。
 *
 * 顺序：INKWELL_PROXY / HTTPS_PROXY / HTTP_PROXY 环境变量 →
 *       Windows 系统代理（注册表 Internet Settings）→ 直连。
 * 之所以要主动探测：Windows 的代理设置存在注册表里，Node 与 Java 都不会自动读取。
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

/**
 * 让 Java 工具（sdkmanager）走代理。
 *
 * sdkmanager 是 Java 程序，不会读 Windows 的 IE 代理设置；
 * 若本机必须经代理才能访问 dl.google.com，不设置就会在
 * 「Fetch remote repository」处失败。
 */
function proxyEnv() {
  const env = { ...process.env };
  if (env.JAVA_TOOL_OPTIONS && env.JAVA_TOOL_OPTIONS.includes('proxyHost')) return env;

  const p = detectProxy();
  if (!p) return env;

  env.JAVA_TOOL_OPTIONS =
    (env.JAVA_TOOL_OPTIONS || '') +
    ' -Dhttp.proxyHost=' + p.host + ' -Dhttp.proxyPort=' + p.port +
    ' -Dhttps.proxyHost=' + p.host + ' -Dhttps.proxyPort=' + p.port;
  return env;
}

function run(cmd, args, opts = {}) {
  // sdkmanager.bat 是批处理文件：Windows 下 spawnSync 必须经由 shell 才能执行，
  // 否则进程静默失败、输出为空（表现为「--list 输出过短（0 字符）」）。
  const isBatch = /\.(bat|cmd)$/i.test(cmd);
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: proxyEnv(),
    shell: isBatch,
    ...opts,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------- 1. cmdline-tools
log('');
log('=== [1/4] Android command-line-tools ===');
if (await exists(sdkmanager)) {
  ok('sdkmanager 已存在');
} else {
  const zip = path.join(tmpdir(), 'inkwell-cmdline-tools.zip');
  let got = false;
  for (const u of CMDLINE_TOOLS_URLS) {
    try {
      await download(u, zip);
      got = true;
      break;
    } catch (e) {
      info('失败: ' + e.message + '，换下一个');
    }
  }
  if (!got) {
    bad('command-line-tools 下载失败');
    process.exit(1);
  }

  const extractDir = path.join(tmpdir(), 'inkwell-cmdline-extract');
  await rm(extractDir, { recursive: true, force: true });
  log('解压...');
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Expand-Archive -LiteralPath "' + zip + '" -DestinationPath "' + extractDir + '" -Force',
    ],
    { stdio: 'inherit' },
  );

  const latest = path.join(sdkRoot, 'cmdline-tools', 'latest');
  await rm(latest, { recursive: true, force: true });
  await mkdir(path.dirname(latest), { recursive: true });
  await rename(path.join(extractDir, 'cmdline-tools'), latest);
  await rm(zip, { force: true });
  ok('已安装到 ' + latest);
}

// ---------------------------------------------------------------- 2. SDK 组件
log('');
log('=== [2/4] 安装 SDK 组件 ===');

if (!process.env.JAVA_HOME) {
  bad('需要 JAVA_HOME 才能运行 sdkmanager');
  process.exit(1);
}
info('JAVA_HOME = ' + process.env.JAVA_HOME);

// 接受许可
log('接受许可协议...');
const yes = 'y\n'.repeat(80);
run(sdkmanager, ['--sdk_root=' + sdkRoot, '--licenses'], { input: yes });

log('查询可用版本...');
const list = run(sdkmanager, ['--sdk_root=' + sdkRoot, '--list']);
const rawOut = list.out;
// sdkmanager 的 --list 有时退出码非 0（代理/进度条干扰）但输出是完整的，只校验内容
if (rawOut.length < 1000) {
  bad('sdkmanager --list 输出过短（' + rawOut.length + ' 字符），可能网络或代理有问题');
  console.error(rawOut.slice(0, 2000));
  process.exit(1);
}

// 关键：--list 输出分为「Installed packages」和「Available Packages」两段。
// 本地仓库段里可能出现尚未发布的版本（例如 android-37），照着它装会失败
// （Warning: Failed to find package）。必须只从 Available Packages 段取版本。
const availIdx = rawOut.indexOf('Available Packages');
if (availIdx < 0) {
  bad('未能在 --list 输出中找到 "Available Packages" 段');
  process.exit(1);
}
const listOut = rawOut.slice(availIdx);
info('--list 输出 ' + rawOut.length + ' 字符，其中可安装段 ' + listOut.length + ' 字符');

function highest(re) {
  const found = [...listOut.matchAll(re)].map((m) => m[1]);
  const uniq = [...new Set(found)];
  if (uniq.length === 0) return null;
  const key = (v) =>
    v
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map(Number);
  uniq.sort((a, b) => {
    const ka = key(a),
      kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const x = ka[i] || 0,
        y = kb[i] || 0;
      if (y !== x) return y - x;
    }
    return 0;
  });
  return uniq[0];
}

const platform = highest(/platforms;android-(\d+)\s/g);
// 排除 rc 预览版（如 37.0.0-rc2），只取正式版
const buildTools = highest(/build-tools;([\d.]+)\s/g);
const ndkAll = [...new Set([...listOut.matchAll(/ndk;([\d.]+)\s/g)].map((m) => m[1]))];
const key = (v) =>
  v
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
ndkAll.sort((a, b) => {
  const ka = key(a),
    kb = key(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i] || 0,
      y = kb[i] || 0;
    if (y !== x) return y - x;
  }
  return 0;
});
// 优先 NDK r27 系列（Tauri Android 模板的默认档位），找不到再顺延
const ndk =
  ndkAll.find((v) => v.startsWith('27.')) ||
  ndkAll.find((v) => v.startsWith('28.')) ||
  ndkAll.find((v) => v.startsWith('26.')) ||
  ndkAll[0];

info('platform    : android-' + platform);
info('build-tools : ' + buildTools);
info('ndk         : ' + ndk);

const pkgs = ['platform-tools', 'cmdline-tools;latest'];
if (platform) pkgs.push('platforms;android-' + platform);
if (buildTools) pkgs.push('build-tools;' + buildTools);
if (ndk) pkgs.push('ndk;' + ndk);

log('安装: ' + pkgs.join(', '));
info('NDK 约 2.5GB，需要几分钟到几十分钟');
const inst = run(sdkmanager, ['--sdk_root=' + sdkRoot, ...pkgs]);
if (inst.code !== 0) {
  console.error(inst.out.slice(-3000));
  bad('sdkmanager 安装失败');
  process.exit(1);
}
for (const p of pkgs) {
  const probe = path.join(sdkRoot, p.replace(/;/g, path.sep));
  if (await exists(probe)) ok('已安装 ' + p);
  else bad('未确认安装 ' + p);
}

// ---------------------------------------------------------------- 3. 环境变量
log('');
log('=== [3/4] 写入用户环境变量 ===');
const ndkPath = ndk ? path.join(sdkRoot, 'ndk', ndk) : null;
const vars = {
  ANDROID_HOME: sdkRoot,
  ANDROID_SDK_ROOT: sdkRoot,
};
if (ndkPath && (await exists(ndkPath))) {
  vars.NDK_HOME = ndkPath;
  vars.ANDROID_NDK_HOME = ndkPath;
}

for (const [k, v] of Object.entries(vars)) {
  run('powershell', [
    '-NoProfile',
    '-Command',
    '[Environment]::SetEnvironmentVariable("' + k + '","' + v + '","User")',
  ]);
  process.env[k] = v;
  ok(k + ' = ' + v);
}

// PATH 追加 platform-tools 与 cmdline-tools
for (const dir of [
  path.join(sdkRoot, 'platform-tools'),
  path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin'),
]) {
  run('powershell', [
    '-NoProfile',
    '-Command',
    '$d="' +
      dir +
      '";$p=[Environment]::GetEnvironmentVariable("Path","User");' +
      'if(-not $p){$p=""};$a=@($p.Split(";")|Where-Object{$_ -ne ""});' +
      'if($a -notcontains $d){[Environment]::SetEnvironmentVariable("Path",((@($a)+$d) -join ";"),"User")}',
  ]);
  process.env.Path = (process.env.Path || '') + ';' + dir;
}
ok('PATH 已追加 platform-tools 与 cmdline-tools');

// ---------------------------------------------------------------- 4. Rust targets
log('');
log('=== [4/4] Rust Android 交叉编译目标 ===');
const targets = [
  'aarch64-linux-android',
  'armv7-linux-androideabi',
  'i686-linux-android',
  'x86_64-linux-android',
];
const installed = run('rustup', ['target', 'list', '--installed']).out;
for (const t of targets) {
  if (installed.includes(t)) {
    ok('已有 ' + t);
    continue;
  }
  log('添加 ' + t + ' ...');
  const r = run('rustup', ['target', 'add', t]);
  if (r.code === 0) ok('已添加 ' + t);
  else bad('添加失败 ' + t + ': ' + r.out.slice(0, 200));
}

log('');
log('Android 环境准备完成。');
log('  下一步: node personal/scripts/../../personal/scripts/build-android.ps1');
