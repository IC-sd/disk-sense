import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

function developmentCsp() {
  return {
    name: 'disk-sense-development-csp',
    apply: 'serve' as const,
    transformIndexHtml(html: string, context: { server?: { httpServer?: { address(): unknown } } }) {
      const address = context.server?.httpServer?.address()
      if (!address || typeof address !== 'object' || !('port' in address)) return html
      return html.replace(
        "connect-src 'self';",
        `connect-src 'self' ws://127.0.0.1:${String(address.port)};`
      )
    }
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), developmentCsp()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    watch: {
      ignored: ['**/release/**', '**/dist/**']
    }
  },
  build: {
    sourcemap: false,
    target: 'chrome150'
  }
})
