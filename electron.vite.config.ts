import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { settings: resolve('src/preload/settings.ts'), overlay: resolve('src/preload/overlay.ts') },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: {
      minify: true,
      rollupOptions: { input: { settings: resolve('src/renderer/settings.html'), overlay: resolve('src/renderer/overlay.html') } }
    }
  }
})
