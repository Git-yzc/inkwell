package com.inkwell.reader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * 把 Android 递进来的「用砚池打开 / 分享到砚池」的文件交给 Rust。
 *
 * 桌面端没有这个类：那边系统直接把文件路径当命令行参数给了进程（见 lib.rs 的
 * first_openable_arg）。Android 的文件是 Intent（ACTION_VIEW / ACTION_SEND），
 * 内容只在这边取得到，所以取到后先存着，等 Rust 来要（takePending）。
 *
 * 配套：Rust 侧 src-tauri/src/openfile.rs；清单里的 intent-filter 见 AndroidManifest.xml。
 */
@TauriPlugin
class OpenFilePlugin(private val host: Activity) : Plugin(host) {

  /** 待处理文件。取走即清空 —— 同一个文件不会打开两次。 */
  private var pendingUri: String? = null

  /** WebView 引用：热启动（应用已经在跑）时用它把「来文件了」推给前端。 */
  private var webView: WebView? = null

  override fun load(webView: WebView) {
    super.load(webView)
    this.webView = webView
    // 冷启动：应用就是被这个 Intent 拉起来的。
    capture(host.intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // 热启动：清单里 Activity 是 singleTask，再次打开文件走的是这里（不新建 Activity）。
    capture(intent)
    notifyWebView()
  }

  /** 供 Rust 侧 run_mobile_plugin("takePending") 调用。 */
  @Command
  fun takePending(invoke: Invoke) {
    val res = JSObject()
    // 没有待打开文件时索性不放这个字段，Rust 侧反序列化成 None。
    pendingUri?.let { res.put("uri", it) }
    pendingUri = null
    invoke.resolve(res)
  }

  private fun capture(intent: Intent?) {
    val uri = extractUri(intent) ?: return
    pendingUri = uri
  }

  /**
   * 从 Intent 里取出文件 URI。
   *
   * 这里不严格校验「是不是 epub」：清单里的 intent-filter 已经把范围限住了，
   * 万一真递进来不能读的东西，导入那条路会给出可读的中文提示，比在这里静默丢弃强。
   */
  private fun extractUri(intent: Intent?): String? {
    if (intent == null) return null
    return when (intent.action) {
      Intent.ACTION_VIEW -> intent.data?.toString()
      Intent.ACTION_SEND -> {
        @Suppress("DEPRECATION")
        val stream: Uri? =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
          } else {
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
          }
        stream?.toString()
      }
      else -> null
    }
  }

  /**
   * 通知前端「有文件要打开」。
   *
   * 只推一个信号、不带内容：前端收到后调 Rust 的 take_pending_open 把文件取走
   * （真正清空也发生在那里）。这样冷启动与热启动共用同一条取文件的路，
   * 也不会出现「内容推了两遍」。
   */
  private fun notifyWebView() {
    val wv = webView ?: return
    if (pendingUri == null) return
    wv.post {
      wv.evaluateJavascript("window.__inkwellOpenFile && window.__inkwellOpenFile()", null)
    }
  }
}
