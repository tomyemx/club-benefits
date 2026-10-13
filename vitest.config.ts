import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The DB test shares one database; run files one after another.
    fileParallelism: false,
  },
});
