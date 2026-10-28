/* @flashmandu-template next.config.js@0.4.0 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Platform images ship Next's traced standalone server instead of the whole
  // node_modules (see the Dockerfile). `next dev` and `next build` are unchanged.
  output: 'standalone',

  // The kit's compiled ./react entry must be transpiled by Next, otherwise
  // webpack fails on import.meta and the embed iframe renders blank.
  transpilePackages: ['@flashmandu/app-bridge-ui'],

  // The app runs inside the platform's embed iframe (cross-origin). Next's
  // default X-Frame-Options: SAMEORIGIN makes the embed render blank.
  // PRODUCTION: narrow frame-ancestors to your platform origins.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https: http://localhost:* http://127.0.0.1:* http://localhost",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
