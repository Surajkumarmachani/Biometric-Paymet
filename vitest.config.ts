import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each gate suite provisions its own database, so files can run in
    // parallel; within a file tests share a database and run sequentially.
    fileParallelism: true,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // See tests/setup/server-only-stub.ts for why this is aliased.
      'server-only': fileURLToPath(
        new URL('./tests/setup/server-only-stub.ts', import.meta.url),
      ),
    },
  },
})
