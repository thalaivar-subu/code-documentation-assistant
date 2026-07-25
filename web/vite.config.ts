import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: webDir,
  plugins: [react()],
  server: { port: 5173 },
});
