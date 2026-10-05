/**
 * App 级外观模式：白天 / 夜间 / 跟随系统（REQ-2026-10-05-08）。
 *
 * 与 reader-settings 里的「阅读主题」（浅色 / 羊皮纸 / 深色）是两个维度：
 * 这个管整个 App 外壳，那个只管正文页面。按 Q15 的定案，切换 App 主题时
 * 总是把阅读主题设为该模式的默认值（夜间 → 深色，白天 → 浅色）。
 *
 * 持久化在 localStorage（纯展示偏好，丢了只是回到默认值）。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { create } from 'zustand';

import { useReaderSettings } from '@/store/reader-settings';

export type AppThemePreference = 'light' | 'dark' | 'system';
/** 解析后的实际主题：跟随系统时由系统深浅决定 */
export type AppTheme = 'light' | 'dark';

const STORAGE_KEY = 'inkwell.app.theme.v1';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 默认白天（Q16，用户指定）。 */
const DEFAULT_PREFERENCE: AppThemePreference = 'light';

function load(): AppThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // 无痕模式等场景读不到，用默认值
  }
  return DEFAULT_PREFERENCE;
}

function systemTheme(): AppTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function resolveTheme(preference: AppThemePreference): AppTheme {
  return preference === 'system' ? systemTheme() : preference;
}

/** 把**解析后**的主题挂到根节点。不能直接写 'system' —— 变量会切不过来。 */
function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.appTheme = theme;
}

/**
 * 切换 App 主题时把阅读主题设成该模式的默认值（Q15）：
 * 夜间 → 深色，白天 → 浅色。「跟随系统」下由系统变化触发的那次切换同样走这里。
 */
function syncReaderTheme(theme: AppTheme): void {
  useReaderSettings.getState().update({ theme: theme === 'dark' ? 'dark' : 'light' });
}

interface AppThemeState {
  preference: AppThemePreference;
  /** 解析后的实际主题 */
  theme: AppTheme;
  setPreference: (preference: AppThemePreference) => void;
}

const initialPreference = load();

export const useAppTheme = create<AppThemeState>((set) => ({
  preference: initialPreference,
  theme: resolveTheme(initialPreference),

  setPreference: (preference) => {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // 写不进去也无所谓，本次会话内照样生效
    }
    const theme = resolveTheme(preference);
    applyTheme(theme);
    set({ preference, theme });
    syncReaderTheme(theme);
  },
}));

/**
 * 启动时调用一次：把当前主题挂上，并让「跟随系统」**实时**跟随。
 *
 * 系统深浅有两条上报通道，两条都汇到同一个处理函数：
 *
 * 1. **CSS 媒体查询** `prefers-color-scheme`：Android WebView / 浏览器上会实时更新。
 * 2. **Tauri 的窗口主题事件** `onThemeChanged`：Windows(WebView2) 上**必须**靠它。
 *    WebView2 不会随系统深浅更新 `prefers-color-scheme` —— 实测现象就是
 *    「选了跟随系统、切系统的夜间模式，App 要重启才跟着变」（§BACKLOG 2.6 ⑥）。
 *
 * `theme` 用 store 里的值做去重：两条通道可能各报一次，重复联动会把用户
 * 手选的阅读主题来回冲掉。
 *
 * ⚠️ 启动时不强制同步阅读主题：那样会每次都覆盖用户手动选的阅读主题。
 * 只有**切换**（以及跟随系统时的系统变化）才按 Q15 联动。
 */
export function initAppTheme(): void {
  applyTheme(useAppTheme.getState().theme);

  const onSystemChange = (next: AppTheme | null): void => {
    if (useAppTheme.getState().preference !== 'system') return;
    const theme = next ?? systemTheme();
    if (theme === useAppTheme.getState().theme) return;
    applyTheme(theme);
    useAppTheme.setState({ theme });
    syncReaderTheme(theme);
  };

  window.matchMedia(DARK_QUERY).addEventListener('change', (e) => {
    onSystemChange(e.matches ? 'dark' : 'light');
  });

  try {
    void getCurrentWindow()
      .onThemeChanged(({ payload }) => {
        onSystemChange(payload === 'dark' ? 'dark' : payload === 'light' ? 'light' : null);
      })
      .catch(() => {
        // 个别平台不提供窗口主题事件：媒体查询那条通道已经覆盖，忽略即可
      });
  } catch {
    // 非 Tauri 环境（例如在浏览器里跑前端）没有窗口 API
  }
}
