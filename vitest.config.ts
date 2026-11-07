import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// .factory-runs holds the repos agents worked on, with their own (sometimes deliberately failing) tests.
export default defineConfig({
  resolve: { alias: { '@/': fileURLToPath(new URL('./apps/dashboard/src/', import.meta.url)) } },
  test: { include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'] },
})
