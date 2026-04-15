import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.{js,jsx}',
      'api/**/*.test.js',
      'server/**/*.test.js',
    ],
  },
})
