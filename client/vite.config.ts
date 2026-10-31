import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client talks to the backend via /api, proxied to the Express server so
// there are no CORS surprises in development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5050',
        changeOrigin: true,
      },
    },
  },
});
