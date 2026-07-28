import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// AI版本Vite配置 - 独立构建配置
export default defineConfig({
  plugins: [react()],
  root: '.',  // 根目录不变，但指向ai.html
  publicDir: 'public',
  server: {
    port: 5174,  // AI版本使用5174端口（非AI版本用5173）
    open: '/ai.html',  // 自动打开ai.html
  },
  build: {
    outDir: 'dist-ai',  // AI版本输出目录
    sourcemap: true,
    rollupOptions: {
      input: '/ai.html',  // AI版本入口HTML
      output: {
        assetFileNames: 'assets-ai/[name]-[hash][extname]',
        chunkFileNames: 'chunks-ai/[name]-[hash].js',
        entryFileNames: 'entry-ai/[name]-[hash].js',
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src-ai',  // AI版本路径别名
    },
  },
  // 共享现有依赖
  optimizeDeps: {
    include: ['react', 'react-dom', 'antd', 'xlsx', '@tauri-apps/api', '@tauri-apps/plugin-sql'],
  },
});