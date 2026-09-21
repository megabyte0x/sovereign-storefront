import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/browser',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: 'index.html',
    },
  },
});
