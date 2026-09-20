package com.inkwell.reader

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 系统栏透明 + 图标用浅色（应用界面本身是深色的）。
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)

    // Android 15 起窗口强制 edge-to-edge：内容会一直画到状态栏 / 导航栏底下。
    // enableEdgeToEdge() 只是「允许」edge-to-edge，系统栏盖在内容上这件事得自己让位，
    // 否则顶部标题栏会与状态栏叠在一起（真机实测重叠）。
    //
    // 这里不用 CSS 的 env(safe-area-inset-*)：Android WebView 只按「屏幕挖孔」上报，
    // 不会把状态栏高度算进去，靠它顶不住。
    findViewById<View>(android.R.id.content)?.let { root ->
      ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
        val bars = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
        WindowInsetsCompat.CONSUMED
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    // 关掉 WebView 自带的缩放。双指一捏会把整页缩到左上角、四周留一大片空白
    // （用户截图里就是这个现象），而 App 外壳并不需要它——
    // 正文大小由阅读设置里的字号控制，捏合缩放反而会打乱分页。
    webView.settings.apply {
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
    }
  }
}
