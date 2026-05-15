import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// 把 dist/sw.js 的 CACHE_VERSION 換成本次 build 時間戳，
// 確保每次部署 SW 內容真的不一樣，瀏覽器才會重新安裝。
function injectSwVersion() {
  return {
    name: 'inject-sw-version',
    apply: 'build',
    closeBundle() {
      const swPath = path.resolve('dist/sw.js');
      if (!fs.existsSync(swPath)) return;
      const version = `bibi-${Date.now()}`;
      const content = fs.readFileSync(swPath, 'utf-8')
        .replace(/CACHE_VERSION = ['"][^'"]+['"]/, `CACHE_VERSION = '${version}'`);
      fs.writeFileSync(swPath, content);
      console.log(`[sw] versioned → ${version}`);
    },
  };
}

export default defineConfig({
  base: '/schedule/',
  plugins: [react(), injectSwVersion()],
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'firebase-vendor': ['firebase/app', 'firebase/auth', 'firebase/firestore'],
          'icons': ['lucide-react'],
        },
      },
    },
  },
});
