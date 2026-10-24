import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // three.js alone is ~520 kB minified; raise the limit so the build output stays warning-free.
    chunkSizeWarningLimit: 1000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
