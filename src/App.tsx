import { useEffect, useRef, useState } from 'react';
import { createHashRouter, Navigate, Outlet, RouterProvider, useNavigate } from 'react-router-dom';

import { openSystemFile } from '@/lib/open-file';
import Library from '@/routes/Library';
import Reader from '@/routes/Reader';

declare global {
  interface Window {
    /**
     * Android 侧收到「用砚池打开 / 分享到砚池」的 Intent 后调这个钩子。
     * 见 `src-tauri/gen/android/.../OpenFilePlugin.kt`。
     */
    __inkwellOpenFile?: () => void;
  }
}

/**
 * 应用外壳：只管「系统要求打开某个文件」这一件事。
 *
 * 刻意放在路由**外层**：它必须与用户当前在哪一页无关 ——
 * 冷启动时停在书库，而 Android 分享进来时可能正在阅读。
 */
function Shell() {
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>(null);
  /** 同一次通知不要并发跑两遍（冷启动与可见性兜底可能几乎同时到）。 */
  const running = useRef(false);

  useEffect(() => {
    const run = async () => {
      if (running.current) return;
      running.current = true;
      try {
        const result = await openSystemFile();
        if (result === null) return;
        if ('id' in result) {
          setNotice(null);
          navigate(`/read/${result.id}`);
        } else {
          setNotice(result.error);
        }
      } finally {
        running.current = false;
      }
    };

    // 1) 冷启动：系统把文件当命令行参数 / Intent 递了进来
    void run();
    // 2) Android 热启动：Intent 到了，Kotlin 侧调这个钩子
    window.__inkwellOpenFile = () => void run();
    // 3) 兜底：回到前台再问一次 —— 万一通知到得比这个钩子挂上还早
    //    （Rust 侧取一次即清空，重复问不会有副作用）
    const onVisible = () => {
      if (!document.hidden) void run();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.__inkwellOpenFile = undefined;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [navigate]);

  // 提示自己消失，别一直占着屏幕底部。
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <>
      <Outlet />
      {notice !== null && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-5">
          <p className="rounded border border-app-border bg-app-surface px-3 py-2 text-xs text-red-500 shadow-lg">
            {notice}
          </p>
        </div>
      )}
    </>
  );
}

// Tauri 下页面通过 tauri:// 协议加载，history 模式的路由会失效，
// 因此统一使用 hash 路由。
const router = createHashRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <Library /> },
      { path: '/read/:id', element: <Reader /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
