import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The SPA always calls same-origin /api/*; in dev Vite proxies it, in prod the host rewrites it
// (vercel.json). Keeps the session cookie first-party (docs/design.md, Engineering decisions).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
