import path from 'node:path';
import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./src/shared/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  // monorepo: trace files from the repository root so workspace packages end up in the standalone bundle
  outputFileTracingRoot: path.join(__dirname, '../..'),
  transpilePackages: ['@shop/shared'],
  poweredByHeader: false,
  async rewrites() {
    // ONLY for running the web app without nginx (`next dev`). In production nginx owns /api: this
    // rewrite matches case-insensitively and would let /API/... reach the api around nginx's rate
    // limits (and be counted under the web container's address). Opt in with ENABLE_API_REWRITE=1.
    if (process.env.NODE_ENV === 'production' && process.env.ENABLE_API_REWRITE !== '1') return [];
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_INTERNAL_URL ?? 'http://localhost:4000'}/:path*`,
      },
    ];
  },
};

export default withNextIntl(config);
