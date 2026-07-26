import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests clone small repos over the network; give them room.
    testTimeout: 60_000,
  },
});
