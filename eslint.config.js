import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**', 'design/**', 'coverage/**', '**/next-env.d.ts', '.data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // The demo agent and sensor bridge are independent clients of the public API.
    files: ['apps/demo-agent/**/*.ts', 'apps/sensor-bridge/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['@culture-atlas/domain*', '@culture-atlas/providers*', '@culture-atlas/agent-gateway*'] }],
    },
  },
);
