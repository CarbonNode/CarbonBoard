/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  distDir: 'out',
  images: {
    unoptimized: true,
  },
  // Use relative paths for file:// protocol in Electron
  assetPrefix: './',
  trailingSlash: true,
}

module.exports = nextConfig
