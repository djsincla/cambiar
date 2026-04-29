import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 10_000,
    include: ['test/**/*.test.js'],
  },
});
