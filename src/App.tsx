import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom';

import Library from '@/routes/Library';
import Reader from '@/routes/Reader';

// Tauri 下页面通过 tauri:// 协议加载，history 模式的路由会失效，
// 因此统一使用 hash 路由。
const router = createHashRouter([
  { path: '/', element: <Library /> },
  { path: '/read/:id', element: <Reader /> },
  { path: '*', element: <Navigate to="/" replace /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
