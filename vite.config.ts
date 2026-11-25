import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// base 由构建期变量注入（规格 §16）：
//   - 自定义域 / 根路径：VITE_BASE=/ 或不设
//   - 项目页 <user>.github.io/<repo>/：VITE_BASE=/<repo>/
// 任何资源引用都必须走 import.meta.env.BASE_URL，禁止硬编码 "/foo.wasm"。
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE ?? '/',

  plugins: [react()],

  resolve: {
    alias: {
      '@': resolve(here, 'src'),
    },
  },

  server: {
    port: 5173,
    // 开发期也需要正确的 wasm MIME（Vite 自带处理）
    headers: {
      // 注意：这里刻意**不加** COOP/COEP。
      // 生产环境（GitHub Pages）无法设置，加了会让开发期与线上行为不一致。
    },
  },

  preview: {
    port: 4173,
  },

  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: mode === 'development',
    // 体积预算里首屏 ≤ 300 KB br，这里用 chunk 拆分来保证
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React 运行时单独一个 chunk：版本不变时浏览器可长期复用
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'react';
          }
          return undefined;
        },
        // 内容寻址：文件名带 hash，配合 SW 的 cache-first 实现「回头客零流量」
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    // wasm 不进模块图（由 fetch 加载），但要确保体积报告能看到
    assetsInlineLimit: 4096,
  },

  worker: {
    // Firefox 114 才支持 module worker；用 iife 兼容更多浏览器
    format: 'iife',
  },

  // wasm 由 runtime fetch 加载，不需要 Vite 的 wasm 插件
  optimizeDeps: {
    exclude: [],
  },
}));
