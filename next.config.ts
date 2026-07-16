import type { NextConfig } from "next";

// Date: 2026-03-22
// No custom webpack config needed — Whisper.js is loaded from CDN dynamically
// and does not require any bundler customisation. Next.js 16 uses Turbopack
// by default which does not support webpack custom config.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
