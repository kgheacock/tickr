import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // testcontainers pulls and starts a Docker image — allow plenty of time.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Run tests in a single fork to avoid competing container startups.
    // fileParallelism: false ensures each file's vi.mock() rebinds cleanly
    // before the next file starts.
    pool: 'forks',
    forks: {
      singleFork: true,
    },
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
  },
});
