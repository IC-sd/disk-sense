import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Cached research projects and review snapshots are not product test suites.
export default mergeConfig(viteConfig, defineConfig({
  test: { include: ['tests/**/*.test.ts'] }
}))
