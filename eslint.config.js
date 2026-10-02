import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', '.wrangler/**', 'coverage/**', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.{ts,js,mjs,cts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
      },
    },
    rules: {
      // Structured logging must go through src/observability/logger.ts.
      // See file-specific override below and docs/SECURITY_MODEL.md.
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  {
    // The logger implementation is the single sanctioned writer to console.
    files: ['src/observability/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Local Node.js maintenance scripts (never shipped to the Worker runtime).
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
);
