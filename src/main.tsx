import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { initAppTheme } from './store/app-theme';
import './styles/globals.css';

// 先定主题再渲染：免得夜间模式先闪一下白底
initAppTheme();

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
