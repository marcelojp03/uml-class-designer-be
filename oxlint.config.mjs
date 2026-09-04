import { defineConfig } from 'oxlint';

export default defineConfig({
  categories: { correctness: 'error', suspicious: 'warn' },
  ignorePatterns: ['dist', 'coverage', 'src/generated'],
  rules: { 'typescript/no-extraneous-class': 'off' },
});
