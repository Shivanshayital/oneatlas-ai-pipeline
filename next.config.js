/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  // `swcMinify` is deprecated in Next 15+, Next manages minification automatically
  typescript: {
    tsconfigPath: './tsconfig.json',
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000',
  },
  // When Next infers workspace root incorrectly, set this to silence warnings
  outputFileTracingRoot: path.resolve(__dirname),
};

module.exports = nextConfig;
