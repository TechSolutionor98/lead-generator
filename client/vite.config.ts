import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend and backend run as SEPARATE services, each with its own .env.
//
// The client reads the backend URL from `NEXT_PUBLIC_API_URL` (see client/.env).
//   - Set it (e.g. http://localhost:5050) to call the backend directly.
//   - Leave it empty to fall back to same-origin /api, which the dev proxy
//     below forwards to the server — handy for quick local runs.
//
// `envPrefix` lets `NEXT_PUBLIC_`-prefixed vars reach the browser, in addition
// to Vite's built-in `VITE_` prefix.
export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
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
