import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // design_claude/ and design_handoff_trading_dashboard/ hold design-
  // reference mockups uploaded via the GitHub web UI — not app code, not
  // bundled; linting them broke every PR's CI. public/vendor/ holds
  // third-party files copied verbatim from node_modules (GSAP, self-hosted
  // 18-09-2026 so a hanging CDN cannot blank the site) — minified library
  // code, exempt for the same reason node_modules is.
  globalIgnores(['dist', 'design_claude', 'design_handoff_trading_dashboard', 'public/vendor', '.claude/worktrees']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
])
