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
    ]
  },
}

export default nextConfig
