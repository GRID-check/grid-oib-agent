import path from 'node:path'
import type { NextConfig } from 'next'
import { AVATAR_IMAGE_PATTERNS } from './src/lib/images/avatar-hosts'
import { LOCAL_IMAGE_PATTERNS } from './src/lib/images/optimizable'

const fileUploadMaxSizeMB = parseInt(process.env.FILE_UPLOAD_MAX_SIZE_MB || '100', 10)

const nextConfig: NextConfig = {
  reactStrictMode: true,

  images: {
    // The optimizer refuses any remote host that is not named here, which is
    // what keeps it from being an open image proxy. Directory avatars are the
    // only remote images we serve; see `avatar-hosts.ts` for why one entry
    // covers the whole directory and what happens to a host that is not on it.
    //
    // Document images are NOT here and must not be: they are streamed from a
    // same-origin route (`/api/documents/[id]/image`), so they are governed by
    // `localPatterns` below. Presigning them to the object store instead would
    // put them on a per-environment host that resolves to a private IP inside
    // the compose network — which the optimizer rejects outright — and would
    // defeat its cache, since every fresh signature is a new cache key.
    remotePatterns: AVATAR_IMAGE_PATTERNS.map((pattern) => ({ ...pattern })),

    // Same-origin paths the optimizer may serve. Leaving this unset does NOT
    // mean "no allow-list": Next 16 defaults it to `[{ pathname: '**', search:
    // '' }]`, which rejects every local URL that carries a query string with
    // `"url" parameter is not allowed`. Our signed document images carry their
    // authorization in the query, so the default blanked every preview and
    // thumbnail in the app. See `optimizable.ts` for the patterns and why the
    // document route is allowed a query string.
    localPatterns: LOCAL_IMAGE_PATTERNS.map((pattern) => ({ ...pattern })),
  },

  experimental: {
    serverActions: {
      bodySizeLimit: `${fileUploadMaxSizeMB}mb`,
    },
    proxyClientMaxBodySize: `${fileUploadMaxSizeMB}mb`,
  },

  // `@ifc-lite/renderer` re-exports a point-cloud renderer that reaches
  // `laz-perf`, whose Emscripten loader imports `wasi_snapshot_preview1` and two
  // virtual specifiers no bundler can resolve — it fails `next build` outright.
  // Grid never decodes a point cloud (a STEP IFC building model contains none),
  // so the dependency is aliased to a loud stub instead. Both bundlers are
  // configured: turbopack serves `next dev` and webpack the production build.
  turbopack: {
    resolveAlias: {
      'laz-perf': './src/lib/bim/laz-perf-stub.ts',
      // The decoder also imports its own `.wasm` through a `?url` specifier,
      // which resolves to an Emscripten loader importing `env` and
      // `wasi_snapshot_preview1`. Aliasing the package alone leaves that second
      // request behind, so both spellings are mapped.
      'laz-perf/lib/web/laz-perf.wasm?url': './src/lib/bim/laz-perf-stub.ts',
      'laz-perf/lib/web/laz-perf.wasm': './src/lib/bim/laz-perf-stub.ts',
    },
  },

  webpack: (config) => {
    config.resolve = config.resolve ?? {}
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      'laz-perf': path.resolve(process.cwd(), 'src/lib/bim/laz-perf-stub.ts'),
      'laz-perf/lib/web/laz-perf.wasm': path.resolve(process.cwd(), 'src/lib/bim/laz-perf-stub.ts'),
    }
    return config
  },

  // Baseline security headers. A full Content-Security-Policy needs nonce
  // plumbing for Next's inline scripts and is tracked as a follow-up —
  // these four are safe unconditionally. HSTS is terminated at the proxy.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      // The base-corpus source-PDF stream is displayed inside a same-origin
      // iframe by the in-app PDF viewer (clicked citations). The global rule
      // above stamps X-Frame-Options: DENY on every route, which the browser
      // honours by refusing to render the preview. Override that single route
      // to allow same-origin framing. This entry must stay AFTER the global
      // `/(.*)` rule: when two matching entries set the same header key, Next
      // emits the last one (see next.config headers "Header Overriding
      // Behavior"), so the more specific SAMEORIGIN replaces DENY here rather
      // than both being emitted. The route handler
      // (streamKnowledgeBaseDocument) sets the same two headers on its Response
      // as defense-in-depth.
      {
        source: '/api/knowledge-base/documents/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
      // The stored-document stream, for the same reason and under the same
      // ordering rule: when the in-app PDF viewer cannot run, it degrades to a
      // same-origin iframe on this route, which the global DENY above would
      // otherwise refuse to render. `streamDocumentFile` sets the same two
      // headers on its Response as defense-in-depth.
      {
        source: '/api/documents/:id/file',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ]
  },
}

export default nextConfig
