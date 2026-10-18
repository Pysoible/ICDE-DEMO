import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: { input: { main: 'index.html', demo: 'demo.html' } },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4327',
    },
  },
});
