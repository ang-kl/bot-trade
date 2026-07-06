import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
// Display format 0.#.### — patch zero-padded to three digits
const [major, minor, patch] = pkg.version.split('.')
const displayVersion = `${major}.${minor}.${String(patch).padStart(3, '0')}`

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(displayVersion),
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.{js,jsx}',
      'api/**/*.test.js',
      'server/**/*.test.js',
    ],
  },
})
