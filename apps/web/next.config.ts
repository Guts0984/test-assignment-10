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
    // Fallback when nginx is not in front: the browser always calls same-origin /api/*
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_INTERNAL_URL ?? 'http://localhost:4000'}/:path*`,
      },
    ];
  },
};

export default withNextIntl(config);
