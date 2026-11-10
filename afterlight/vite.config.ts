import { defineConfig } from 'vitest/config';

export default defineConfig({
  // CrazyGames requires relative paths inside the uploaded bundle.
  base: './',
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { host: true, port: 5173 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
