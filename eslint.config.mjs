import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/** FSD layers, top → bottom. A layer may import only from layers below it. */
const FSD_LAYERS = ['app', 'views', 'widgets', 'features', 'entities', 'shared'];
const fsdOverrides = FSD_LAYERS.map((layer, i) => {
  const forbidden = FSD_LAYERS.slice(0, i); // everything above
  return {
    files: [`apps/web/src/${layer}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: forbidden.map((l) => ({
            group: [`@/${l}`, `@/${l}/*`],
            message: `FSD: layer "${layer}" must not import from upper layer "${l}".`,
          })),
        },
      ],
    },
  };
});

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'packages/db/migrations/**',
      '**/next-env.d.ts',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': 'allow-with-description',
          'ts-expect-error': 'allow-with-description',
          'ts-nocheck': true,
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      eqeqeq: ['error', 'always'],
      // Functional style: classes are allowed only in apps/api (NestJS requires them).
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ClassDeclaration, ClassExpression',
          message: 'Classes are allowed only in apps/api (NestJS). Use functions and modules.',
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  {
    // NestJS needs classes + decorators + injected params typed as classes.
    files: ['apps/api/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  ...fsdOverrides,
);
