import { defineConfig } from 'vitest/config'

// .factory-runs holds the repos agents worked on, with their own (sometimes deliberately failing) tests.
export default defineConfig({
  test: { include: ['packages/*/test/**/*.test.ts'] },
})
