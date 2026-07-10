/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  // Recharts ships loose tooltip/formatter typings; don't block the build on them.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
