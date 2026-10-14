import { defineConfig } from 'vitest/config';

// End-to-end: drives the built app (`next build` first) in Chromium.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
