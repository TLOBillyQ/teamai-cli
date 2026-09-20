import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/e2e/**/*.test.ts',
      'src/__tests__/*-e2e.test.ts',
      'validation/*.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Real provider flows are exercised here with explicit tokens; the guard keeps
    // a stray credential prompt (GUI helper / askpass) from blocking the run.
    setupFiles: ['src/__tests__/setup/git-guard.ts'],
    // E2E tests spawn child processes and touch the real filesystem.
    // Run test files sequentially to avoid race conditions (parallel
    // file-level execution causes intermittent "Cannot find module
    // dist/index.js" on GitHub Actions CI runners).
    fileParallelism: false,
    // Retry once: flaky tests recover, real bugs stay failed.
    retry: 1,
  },
});
