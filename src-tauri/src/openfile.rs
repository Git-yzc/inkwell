//! 「用砚池打开」在 Android 上的落地：把 Intent 里的文件交给 Rust。
//!
//! 桌面端不需要这个模块 —— 那边系统直接把文件路径当命令行参数递给进程，
//! 由 `lib.rs` 从 `std::env::args()` 取（见 `first_openable_arg`）。
//! Android 的文件是 Intent（`ACTION_VIEW` / `ACTION_SEND`），只有 Kotlin 侧拿得到，
//! 所以这里挂一个 Tauri 移动插件，向 Kotlin 要那个 URI。
//!
//! Kotlin 实现见 `src-tauri/gen/android/app/src/main/java/com/inkwell/reader/OpenFilePlugin.kt`。

use tauri::{plugin::TauriPlugin, Runtime};
// `manage` 来自 Manager trait；只有 Android 那条分支用得到它。
#[cfg(target_os = "android")]
use tauri::Manager;

/// Tauri 插件名。Kotlin 侧以这个名字注册进 PluginManager，两边必须一致。
const PLUGIN_NAME: &str = "openfile";
/// Kotlin 类所在的包名。
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.inkwell.reader";
/// Kotlin 类名（`@TauriPlugin` 注解的那个类）。
#[cfg(target_os = "android")]
const PLUGIN_CLASS: &str = "OpenFilePlugin";

/// Kotlin 侧 `takePending` 的返回体。没有待打开文件时 `uri` 整个字段缺失。
#[cfg(target_os = "android")]
#[derive(Debug, serde::Deserialize)]
struct PendingUri {
    uri: Option<String>,
}

#[cfg(target_os = "android")]
pub struct OpenFile<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> OpenFile<R> {
    /// 取走 Android 递进来的文件 URI（取一次即清空）。
    ///
    /// 返回的可能是 `content://`（SAF / 分享）也可能是 `file://`，
    /// 两者都能直接喂给导入那条链路（content:// 的落地见 BACKLOG §2.4）。
    pub fn take(&self) -> Result<Option<String>, String> {
        let res = self
            .0
            .run_mobile_plugin::<PendingUri>("takePending", ())
            .map_err(|e| format!("读取 Android Intent 失败：{e}"))?;
        Ok(res.uri.filter(|s| !s.is_empty()))
    }
}

/// 注册移动端插件。桌面端是个空壳（插件名照样注册，进去什么都不做）。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api
                    .register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)
                    .map_err(|e| format!("注册 Android 插件失败：{e}"))?;
                app.manage(OpenFile(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                // 桌面端走命令行参数，这里没有要注册的东西。
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}
