// Flat ESLint config (ESLint 9+/typescript-eslint). Type-unaware recommended set —
// fast, no tsconfig project wiring needed. Tighten to type-checked rules later if useful.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', '.cache', 'data', 'models', 'dist', 'web/dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
