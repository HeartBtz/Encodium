'use strict';

const baseRules = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-constant-condition': 'warn',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-var': 'error',
  'prefer-const': 'warn',
  eqeqeq: ['warn', 'smart'],
  'no-throw-literal': 'error',
  'no-unreachable': 'error',
  'no-duplicate-case': 'error',
  'no-fallthrough': 'warn',
  'no-redeclare': 'error',
  'no-shadow': 'warn',
  curly: ['warn', 'multi-line'],
  'no-eval': 'error',
  'no-implied-eval': 'error',
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'dist/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
    rules: baseRules,
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script' },
  },
];
