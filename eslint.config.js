import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Tenant isolation: only apps/api/src/db may talk to MongoDB directly (see docs/design.md, invariant 3).
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
    ignores: ['apps/api/src/db/**', 'apps/api/test/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'mongodb', message: 'Use orgRepo(actor) from apps/api/src/db instead.' }] },
      ],
    },
  },
);
