import { defineConfig } from 'vitest/config'

// Runs only the name fixture beside it: no suite setup, no target, no network.
export default defineConfig({
  test: {
    include: ['**/*.fixture.mjs'],
    reporters: ['json'],
  },
})
