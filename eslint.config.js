import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
];
