import path from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    css: false,
    globals: true,
    environment: 'happy-dom',
    /**
     * Do not let happy-dom actually LOAD an `<iframe>`'s src.
     *
     * happy-dom treats an iframe as a real navigation and fires a network
     * request for it. Nothing in this suite wants that — the specs assert on
     * the `src` attribute, not on what a document server would return — and it
     * is not merely wasteful: the request outlives the test, so teardown aborts
     * it mid-flight, and that abort path (`Fetch.onAsyncTaskManagerAbort` →
     * `ClientRequest.destroy`) trips a libuv assertion that takes the whole
     * worker fork down with `Worker exited unexpectedly`. The run then reports
     * every remaining test as passed while silently never running one file's
     * worth of them.
     *
     * The symptom was visible long before it was fatal: the suite has been
     * printing `ECONNREFUSED 127.0.0.1:3000` and aborted-fetch stack traces
     * from the PDF-viewer specs for as long as those specs have rendered a
     * frame. It only became a crash once enough specs did it at once.
     */
    environmentOptions: {
      happyDOM: { settings: { navigation: { disableChildFrameNavigation: true } } },
    },
    testTimeout: 50000,
    root: './',
    include: [
      'src/**/*.{spec,test}.{ts,tsx}',
      'tests/**/*.test.{ts,tsx}',
      'purger/**/*.spec.mjs',
      'scheduler/**/*.spec.mjs',
      'observability/**/*.spec.mjs',
      'scripts/**/*.spec.mjs',
      'eslint-rules/**/*.spec.mjs',
    ],
    exclude: ['**/mocks/**', '**/node_modules/**'],
    setupFiles: ['./config/vitest/polyfills.ts', './config/vitest/vitest.setup.ts'],
    clearMocks: true,
    server: {
      deps: {
        inline: [/@nvidia/],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'cobertura', 'html'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/**',
        'config/**',
        '**/*.{spec,test}.{ts,tsx}',
        '**/mocks/**',
        '**/test-utils/**',
        '**/*.d.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@/adapters': path.resolve(__dirname, './src/adapters'),
      '@/features': path.resolve(__dirname, './src/features'),
      '@/shared': path.resolve(__dirname, './src/shared'),
      'server-only': path.resolve(
        __dirname,
        './config/vitest/mocks/server-only.ts',
      ),
      'external-svg-loader': path.resolve(
        __dirname,
        './config/vitest/mocks/external-svg-loader.ts',
      ),
      'external-svg-loader/dist/svg-loader.min.js': path.resolve(
        __dirname,
        './config/vitest/mocks/external-svg-loader.ts',
      ),
    },
  },
})
