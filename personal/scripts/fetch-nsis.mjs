/**
 * 砚池 (Inkwell) —— 预下载 NSIS 打包工具链。
 *
 * 为什么需要这个脚本：
 * Tauri 打 Windows 安装包时，会临时从 GitHub Releases 下载 NSIS 3.11。
 * 本机网络环境下这一步经常超时（failed to bundle project: timeout: global），
 * 导致 Rust 明明编译成功、却出不了安装包。
 * 本脚本把 NSIS 预先放进 Tauri 约定的缓存目录，之后打包完全离线。
 *
 * 缓存位置（Tauri 源码 crates/tauri-bundler/src/bundle/windows/nsis/mod.rs 中的
 * tauri_tools_path = dirs::cache_dir()/tauri）：
 *     %LOCALAPPDATA%\tauri\NSIS
 *
 * 用法：
 *     node personal/scripts/fetch-nsis.mjs
 *
 * 下载内容与官方校验值（与 Tauri 源码中的常量一致）：
 *     nsis-3.11.zip           SHA1 EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D
 *     nsis_tauri_utils.dll    SHA1 75197FEE3C6A814FE035788D1C34EAD39349B860
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const NSIS_URL =
  'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip';
const NSIS_SHA1 = 'ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d';

const UTILS_URL =
  'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll';
const UTILS_SHA1 = '75197fee3c6a814fe035788d1c34ead39349b860';

// Tauri 打包前会检查这些文件是否齐全（同源码 NSIS_REQUIRED_FILES）
const REQUIRED = [
  'makensis.exe',
  'Bin/makensis.exe',
  'Stubs/lzma-x86-unicode',
  'Stubs/lzma_solid-x86-unicode',
  'Plugins/x86-unicode/additional/nsis_tauri_utils.dll',
  'Include/MUI2.nsh',
  'Include/FileFunc.nsh',
  'Include/x64.nsh',
  'Include/nsDialogs.nsh',
  'Include/WinMessages.nsh',
  'Include/Win/COM.nsh',
  'Include/Win/Propkey.nsh',
  'Include/Win/RestartManager.nsh',
];

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  console.error('未找到 LOCALAPPDATA 环境变量');
  process.exit(1);
}

const tauriTools = path.join(localAppData, 'tauri');
const nsisPath = path.join(tauriTools, 'NSIS');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  console.log('下载: ' + url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);

  const total = Number(res.headers.get('content-length') || 0);
  let done = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    done += c.length;
    if (total > 0) {
      const pct = Math.floor((done / total) * 100);
      if (pct >= lastPct + 20) {
        lastPct = pct;
        console.log(
          '  ' +
            pct +
            '%  (' +
            Math.round(done / 1048576) +
            '/' +
            Math.round(total / 1048576) +
            ' MB)',
        );
      }
    }
  });
  await pipeline(body, createWriteStream(dest));
  return dest;
}

async function sha1(file) {
  const hash = createHash('sha1');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function verify(file, expected, label) {
  const actual = await sha1(file);
  if (actual !== expected) {
    throw new Error(label + ' 校验失败\n  期望 ' + expected + '\n  实际 ' + actual);
  }
  console.log('  ' + label + ' SHA1 校验通过');
}

async function checkRequired() {
  const missing = [];
  for (const f of REQUIRED) {
    if (!(await exists(path.join(nsisPath, f.replace(/\//g, path.sep))))) missing.push(f);
  }
  return missing;
}

// ---------------------------------------------------------------- 主流程

// 已就绪则直接退出（幂等）
if (await exists(nsisPath)) {
  const missing = await checkRequired();
  if (missing.length === 0) {
    console.log('NSIS 已就绪: ' + nsisPath);
    process.exit(0);
  }
  console.log('NSIS 目录存在但缺少 ' + missing.length + ' 个文件，重新安装');
  await rm(nsisPath, { recursive: true, force: true });
}

await mkdir(tauriTools, { recursive: true });

const tmpZip = path.join(tmpdir(), 'inkwell-nsis-3.11.zip');
const tmpDll = path.join(tmpdir(), 'inkwell-nsis_tauri_utils.dll');

try {
  // 1) NSIS 主包
  await download(NSIS_URL, tmpZip);
  await verify(tmpZip, NSIS_SHA1, 'nsis-3.11.zip');

  // 2) 解压。zip 内顶层目录是 nsis-3.11
  console.log('解压到: ' + tauriTools);
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Expand-Archive -LiteralPath "' + tmpZip + '" -DestinationPath "' + tauriTools + '" -Force',
    ],
    { stdio: 'inherit' },
  );

  const extracted = path.join(tauriTools, 'nsis-3.11');
  if (!(await exists(extracted))) {
    const entries = await readdir(tauriTools);
    throw new Error('解压后未找到 nsis-3.11 目录。实际内容: ' + entries.join(', '));
  }
  await rename(extracted, nsisPath);
  console.log('已就位: ' + nsisPath);

  // 3) Tauri 专用插件 DLL
  await download(UTILS_URL, tmpDll);
  await verify(tmpDll, UTILS_SHA1, 'nsis_tauri_utils.dll');

  const { readFile } = await import('node:fs/promises');
  const dllData = await readFile(tmpDll);
  const dllDir = path.join(nsisPath, 'Plugins', 'x86-unicode', 'additional');
  await mkdir(dllDir, { recursive: true });
  await writeFile(path.join(dllDir, 'nsis_tauri_utils.dll'), dllData);
  console.log('插件已就位');

  // 4) 完整性检查
  const missing = await checkRequired();
  if (missing.length > 0) {
    throw new Error('安装后仍缺少文件: ' + missing.join(', '));
  }
  console.log('');
  console.log('NSIS 工具链准备完成，之后打包不再需要联网。');
} catch (e) {
  console.error('');
  console.error('失败: ' + e.message);
  process.exit(1);
} finally {
  await rm(tmpZip, { force: true });
  await rm(tmpDll, { force: true });
}
