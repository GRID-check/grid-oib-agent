import type { NextConfig } from 'next'

const fileUploadMaxSizeMB = parseInt(process.env.FILE_UPLOAD_MAX_SIZE_MB || '100', 10)

const nextConfig: NextConfig = {
  reactStrictMode: true,

  experimental: {
    serverActions: {
      bodySizeLimit: `${fileUploadMaxSizeMB}mb`,
    },
    proxyClientMaxBodySize: `${fileUploadMaxSizeMB}mb`,
  },

  turbopack: {},

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
    ]
  },
}

export default nextConfig
