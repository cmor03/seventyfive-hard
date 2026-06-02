import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    // Let the Next/Vercel image optimizer fetch and resize progress photos
    // stored in Firebase Storage so the gallery serves tiny thumbnails.
    remotePatterns: [
      { protocol: "https", hostname: "firebasestorage.googleapis.com" },
      { protocol: "https", hostname: "*.firebasestorage.app" },
      { protocol: "https", hostname: "storage.googleapis.com" },
    ],
    // Small renditions are all the grid needs.
    imageSizes: [48, 96, 128, 256, 384],
    deviceSizes: [640, 828, 1080, 1200],
  },
};

export default nextConfig;
