import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['local.tickr.keithheacock.com'],
    // The e2e/ folder holds standalone Playwright scripts that drive the running
    // dev server — they aren't part of the app bundle. Ignore them in the
    // watcher so editing/adding a test file doesn't reload the app mid-run.
    watch: {
      ignored: ['**/e2e/**'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
