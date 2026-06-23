import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { PALETTES, type PaletteId } from './constants';
import App from './App';
import './index.css';

// 启动时读取上次保存的调色板，把 data-palette 写回 <html>，让 CSS 在 React mount 之前就生效，
// 同时让 Ant Design 的 colorPrimary 跟随主题，避免 Slider / Progress 等组件保持过期红色。
// 启动时读取上次保存的偏好（调色板 / 深浅 / 动效 / 色温），让 <html> 立刻带属性，CSS 在 React mount 之前就生效
const PALETTE_PRIMARY: Record<PaletteId, string> = {
  apple:   '#BF5AF2',
  tiffany: '#0ABAB5',
  paper:   '#0F172A',
  rose:    '#E879A8',
  aurora:  '#14B8A6',
  mint:    '#34D399',
  sky:     '#60A5FA',
};
const initialPaletteRaw = (typeof localStorage !== 'undefined' && localStorage.getItem('app-palette')) || 'apple';
const initialPalette: PaletteId = (PALETTES.find(p => p.id === initialPaletteRaw)?.id) ?? 'apple';
const primary = PALETTE_PRIMARY[initialPalette];
if (typeof document !== 'undefined') {
  const html = document.documentElement;
  html.setAttribute('data-palette', initialPalette);
  if (!html.hasAttribute('data-theme')) html.setAttribute('data-theme', 'light');
  if (!html.hasAttribute('data-motion')) html.setAttribute('data-motion', 'on');
  if (!html.hasAttribute('data-color-temp')) html.setAttribute('data-color-temp', 'default');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: primary,
          colorSuccess: '#30D158',
          colorWarning: '#FF9F0A',
          colorError: '#FF375F',
          colorInfo: '#5E5CE6',
          borderRadius: 12,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
          wireframe: false,
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
