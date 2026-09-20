/**
 * 用 CDP 驱动真实应用做验证（做法见 AGENTS.md §5.4）。
 *
 * 为什么需要它：界面类改动光看构建通过远远不够。WebView2 支持远程调试，
 * 可以直接读真实应用的 DOM、点按钮、取 foliate-view 的内部状态。
 * 实测一轮就抓出过三个「界面能打开、功能全废」的 bug。
 *
 * 用法：
 *   1) 带调试端口启动应用（要让进程常驻，否则 CDP 连不上）：
 *        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
 *        & "$env:LOCALAPPDATA\Inkwell\inkwell.exe"
 *   2) 另开一个终端跑：
 *        node personal/scripts/cdp.mjs "document.title"
 *        node personal/scripts/cdp.mjs "location.hash = '#/read/<bookId>'; 'ok'"
 *
 * 表达式里可以写多语句；返回值会被 JSON 化后打印。
 * 端口可用环境变量 CDP_PORT 覆盖（默认 9222）。
 *
 * ⚠️ foliate-js 的 View / Paginator 用 attachShadow({mode:'closed'})，影子树读不到。
 *    但 book / lastLocation / renderer 是公开属性，且 renderer.getContents()
 *    能拿到书籍文档（{ doc, index }），据此足以检查正文排版：
 *      const v = document.querySelector('foliate-view')
 *      const doc = v.renderer.getContents()[0].doc
 *      doc.defaultView.getComputedStyle(doc.querySelector('p')).textIndent
 */
const PORT = process.env.CDP_PORT || 9222;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!target) {
  console.error('未找到调试目标（应用没在跑？没带 --remote-debugging-port？）：');
  console.error(JSON.stringify(list, null, 2));
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result);
});

function send(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const expr = process.argv.slice(2).join(' ');
if (!expr) {
  console.error('用法: node personal/scripts/cdp.mjs "<js 表达式>"');
  process.exit(2);
}

const r = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
  userGesture: true,
});

if (r.exceptionDetails) {
  console.error('EXCEPTION: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  process.exit(1);
}
const v = r.result.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
ws.close();
