import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'node_modules', 'public']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Web Workers have their own global scope.
    files: ['**/*.worker.ts'],
    languageOptions: {
      globals: globals.worker,
    },
  },
  {
    // Vitest tests run in happy-dom (browser-like) and use Node/test globals.
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
])
