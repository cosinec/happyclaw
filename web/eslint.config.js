// ESLint for the web app (flat config). Formatting stays with Prettier and
// type errors with `tsc`; lint covers what those miss: hook rules, unused or
// unreachable code, and common TypeScript foot-guns.
//
// `npm run lint` fails on errors only. Rules that existing code still trips
// in many places start as warnings so they are visible without blocking;
// tighten them to errors as the counts reach zero.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'public',
      'playwright-report',
      'test-results',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // tsc's noUnusedLocals/Parameters already reject real dead code; here
      // only the cases it does not cover, with the usual `_` opt-out for
      // destructuring that omits a key.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      // `cond ? a() : b()` as a statement is an accepted idiom here.
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
      // Deliberately swallowed failures are written as `catch {}`.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Prettier decides line breaks.
      'no-unexpected-multiline': 'off',

      // Baseline: warn until the existing occurrences are cleaned up.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
);
