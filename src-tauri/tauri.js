/**
 * Gradle Rust 构建任务的适配层（shim）。
 *
 * 为什么需要这个文件：
 * Tauri 生成的 Android 工程里，`buildSrc/.../BuildTask.kt` 会以
 *     node tauri android android-studio-script --release --target <triple>
 * 的方式回调 Tauri CLI（工作目录是 src-tauri/），因此这里必须存在一个
 * 能被 `node tauri` 解析到的入口。
 *
 * 为什么不用官方 CLI：
 * 官方 CLI 把编译好的 .so 以**符号链接**方式放进 jniLibs，而 Windows 上创建
 * 符号链接需要「开发者模式」或管理员权限，本机都没有，会导致：
 *     Creation symbolic link is not allowed for this system.
 * 本 shim 改为「cargo 编译 + 复制文件」，效果等价且不需要任何特权。
 *
 * 行为：解析 --target / --release，调 cargo 编译对应三元组，
 *       再把 libinkwell_lib.so 复制到 jniLibs 对应的 ABI 目录。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Gradle 传的是简写（aarch64 / armv7 / i686 / x86_64），
// 但手动调用时可能传完整三元组，两种都接受。
const TRIPLES = {
  aarch64: 'aarch64-linux-android',
  armv7: 'armv7-linux-androideabi',
  i686: 'i686-linux-android',
  x86_64: 'x86_64-linux-android',
  'aarch64-linux-android': 'aarch64-linux-android',
  'armv7-linux-androideabi': 'armv7-linux-androideabi',
  'i686-linux-android': 'i686-linux-android',
  'x86_64-linux-android': 'x86_64-linux-android',
};

const ABI_BY_TRIPLE = {
  'aarch64-linux-android': 'arm64-v8a',
  'armv7-linux-androideabi': 'armeabi-v7a',
  'i686-linux-android': 'x86',
  'x86_64-linux-android': 'x86_64',
};

const args = process.argv.slice(2);

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const targetArg = argValue('--target');
const release = args.includes('--release');

if (!targetArg) {
  console.error('[inkwell] 缺少 --target 参数，收到: ' + args.join(' '));
  process.exit(2);
}

const target = TRIPLES[targetArg];
const abi = target ? ABI_BY_TRIPLE[target] : null;
if (!target || !abi) {
  console.error('[inkwell] 未知的 Rust 目标: ' + targetArg);
  console.error('[inkwell] 支持: ' + Object.keys(TRIPLES).join(', '));
  process.exit(2);
}

const srcTauri = path.dirname(fileURLToPath(import.meta.url));
const profile = release ? 'release' : 'debug';

/**
 * 配置 NDK 交叉编译工具链。
 *
 * 平时这些环境变量由 Tauri CLI 自动注入；我们绕过了 CLI，就得自己设。
 * 不设的话 cargo 会去找宿主机的 cc，报 "linker `cc` not found"。
 *
 * clang 包装器按 API level 命名（如 aarch64-linux-android26-clang.cmd），
 * 需与 tauri.conf.json 里的 minSdkVersion 保持一致（当前 26）。
 */
const MIN_SDK = '26';

const NDK_BY_TRIPLE = {
  'aarch64-linux-android': 'aarch64-linux-android' + MIN_SDK + '-clang',
  // 注意 armv7 的前缀是 armv7a-（带 a），与 Rust 三元组名不同
  'armv7-linux-androideabi': 'armv7a-linux-androideabi' + MIN_SDK + '-clang',
  'i686-linux-android': 'i686-linux-android' + MIN_SDK + '-clang',
  'x86_64-linux-android': 'x86_64-linux-android' + MIN_SDK + '-clang',
};

/**
 * Windows 上必须用 .cmd 变体。
 * 无扩展名的那个是 bash 脚本，CreateProcess 直接执行会报
 * "os error 193: 不是有效的 Win32 应用程序"。
 */
const CLANG_SUFFIX = process.platform === 'win32' ? '.cmd' : '';

function findNdkBin() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const ndkRoot = path.join(sdk, 'ndk');
  if (!existsSync(ndkRoot)) return null;
  const versions = readdirSync(ndkRoot).sort().reverse();
  for (const v of versions) {
    const bin = path.join(ndkRoot, v, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin');
    if (existsSync(bin)) return bin;
  }
  return null;
}

const env = { ...process.env };
const ndkBin = findNdkBin();
if (ndkBin) {
  const clang = path.join(ndkBin, NDK_BY_TRIPLE[target] + CLANG_SUFFIX);

  // 只设「目标限定」的变量，绝不设全局 CC/CXX/AR。
  // 全局设置会污染宿主的 build script（例如 vswhom-sys 要用 MSVC 编译），
  // 导致 'windows.h' file not found 之类的错误。
  const key = target.toUpperCase().replace(/-/g, '_');
  env['CARGO_TARGET_' + key + '_LINKER'] = clang;
  env['CC_' + target] = clang;
  env['CXX_' + target] = clang;
  env['AR_' + target] = path.join(ndkBin, 'llvm-ar.exe');
  env['RANLIB_' + target] = path.join(ndkBin, 'llvm-ranlib.exe');

  // 清除可能从外部继承来的全局设置，避免同类污染
  for (const k of ['CC', 'CXX', 'AR', 'RANLIB', 'CFLAGS', 'CXXFLAGS']) delete env[k];

  console.log('[inkwell] NDK 工具链: ' + ndkBin);
} else {
  console.error('[inkwell] 未找到 Android NDK，请先运行 setup-android.mjs');
  process.exit(1);
}

console.log('[inkwell] cargo build --target ' + target + ' (' + profile + ')');

const cargoArgs = ['build', '--target', target];
if (release) {
  cargoArgs.push('--release');

  // 关键：release 必须开 custom-protocol，否则 tauri 的 build.rs 会把 dev 置为 true，
  // 二进制就会去连 http://localhost:1420/ 而不是内嵌 dist/ 里的前端资源，
  // 手机上表现为一启动就报 'Failed to request http://localhost:1420/'。
  // 官方 CLI 在 release 时会自动加这个特性，我们绕过了 CLI，所以在这里补上。
  //
  // debug 不加：Gradle 的 debug 任务由 'pnpm tauri android dev --host' 驱动，
  // 那条路要连宿主机的 devUrl（CLI 会把 devUrl 改写成局域网 IP），内嵌资源反而会坏事。
  cargoArgs.push('--features', 'custom-protocol');
}

try {
  execFileSync('cargo', cargoArgs, { cwd: srcTauri, stdio: 'inherit', env });
} catch (e) {
  console.error('[inkwell] cargo 编译失败');
  process.exit(1);
}

const built = path.join(srcTauri, 'target', target, profile, 'libinkwell_lib.so');
if (!existsSync(built)) {
  console.error('[inkwell] 未找到编译产物: ' + built);
  process.exit(1);
}

const jniDir = path.join(srcTauri, 'gen', 'android', 'app', 'src', 'main', 'jniLibs', abi);
mkdirSync(jniDir, { recursive: true });

const dest = path.join(jniDir, 'libinkwell_lib.so');
// 目标位置可能是上次构建留下的符号链接，先删掉再复制，避免写进链接指向处
rmSync(dest, { force: true });
copyFileSync(built, dest);

console.log('[inkwell] 已复制到 ' + path.relative(srcTauri, dest));
