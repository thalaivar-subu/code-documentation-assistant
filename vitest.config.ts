import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'eval/**/*.test.ts', 'tests/**/*.test.ts'],
    // Integration tests clone small repos over the network; give them room.
    testTimeout: 60_000,
  },
});
