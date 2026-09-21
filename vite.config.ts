import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/adapters/credentials.ts',
      formats: ['es'],
      fileName: 'credentials',
    },
    outDir: 'dist/browser',
    emptyOutDir: true,
    target: 'es2022',
  },
});
