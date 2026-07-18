import type { NextConfig } from "next";

const staticDemo = process.env.NEXUS_STATIC_DEMO === "true";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(staticDemo
    ? {
        output: "export" as const,
        basePath: "/nexus-operacional",
        trailingSlash: true,
        images: { unoptimized: true }
      }
    : {}),
  devIndicators: false,
  experimental: {
    optimizePackageImports: ["lucide-react", "echarts-for-react"]
  },
  webpack(config) {
    config.cache = false;
    return config;
  }
};

export default nextConfig;
