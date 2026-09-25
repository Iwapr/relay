import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// PDF.js loads auxiliary resources by their original names, including CJK font maps.
const pdfDirectory = fileURLToPath(new URL('../../node_modules/pdfjs-dist/', import.meta.url));
const pdfAssets = new Map<string, string>(
  ['wasm', 'cmaps', 'standard_fonts'].flatMap((directory) =>
    readdirSync(resolve(pdfDirectory, directory)).map(
      (name) => [`${directory}/${name}`, resolve(pdfDirectory, directory, name)] as const,
    ),
  ),
);
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    react(),
    {
      name: 'pdfjs-preview-assets',
      buildStart() {
        if (this.environment.config.command !== 'build') return;
        for (const [name, filename] of pdfAssets)
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${name}`,
            source: readFileSync(filename),
          });
      },
      configureServer(server) {
        server.middlewares.use('/pdfjs/', (req, res, next) => {
          const name = req.url?.slice(1).split('?')[0];
          const filename = name && pdfAssets.get(name);
          if (!filename) return next();
          res.setHeader(
            'Content-Type',
            name.endsWith('.wasm')
              ? 'application/wasm'
              : name.endsWith('.js')
                ? 'text/javascript'
                : 'application/octet-stream',
          );
          res.end(readFileSync(filename));
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:4080', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  worker: { format: 'es' },
});
