import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'workspace/AEG-104/workloadBalancer.test.ts'],
    // Suites share host resources (git remotes, temp dirs, ports), so they run
    // sequentially like the previous tsx chain instead of in parallel files.
    fileParallelism: false,
    // Suites execute real git, sandbox, and delivery operations that take
    // minutes; the 5s default test timeout does not apply to them.
    testTimeout: 900_000,
  },
});
