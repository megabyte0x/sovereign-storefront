import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, defineConfig, type Plugin } from 'vite';

function embedBundle(): Plugin {
  let built = false;
  return {
    name: 'ssf-embed-bundle',
    apply: 'build',
    async closeBundle() {
      if (built) return;
      built = true;
      await build({
        configFile: false,
        logLevel: 'warn',
        build: {
          emptyOutDir: false,
          outDir: 'dist/browser',
          target: 'es2022',
          lib: {
            entry: resolve('src/browser/embed.ts'),
            formats: ['iife'],
            name: 'SsfEmbed',
            fileName: () => 'embed.js',
          },
          rollupOptions: {
            output: { inlineDynamicImports: true },
          },
        },
      });
      const file = resolve('dist/browser/embed.js');
      const sri = `sha384-${createHash('sha384').update(readFileSync(file)).digest('base64')}`;
      writeFileSync(resolve('dist/browser/embed.sri.txt'), `${sri}\n`);
    },
  };
}

export default defineConfig({
  plugins: [embedBundle()],
  build: {
    outDir: 'dist/browser',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve('index.html'),
        checkout: resolve('checkout.html'),
      },
    },
  },
});
