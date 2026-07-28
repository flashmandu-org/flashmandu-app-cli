/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Flashmandu delivers webhooks with a fixed set of headers; nothing exotic.
  experimental: {},
};

export default nextConfig;
