/// <reference types="vite/client" />

/**
 * Typed environment variables exposed to the browser bundle.
 *
 * Vite only inlines vars with an allowed prefix. We allow both `VITE_` (Vite's
 * default) and `NEXT_PUBLIC_` (configured via `envPrefix` in vite.config.ts) so
 * `NEXT_PUBLIC_API_URL` works the same way it would in a Next.js app.
 */
interface ImportMetaEnv {
  /** Full origin of the backend API, e.g. http://localhost:5050 (preferred). */
  readonly NEXT_PUBLIC_API_URL?: string;
  /** Alias kept for Vite-native naming; same meaning as NEXT_PUBLIC_API_URL. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
