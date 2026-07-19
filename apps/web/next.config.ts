import type { NextConfig } from "next";
import path from "node:path";

const staticDemo = process.env.NEXUS_STATIC_DEMO === "true";
const apiInternalUrl = (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3333").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(staticDemo
    ? {
        output: "export" as const,
        basePath: "/nexus-operacional",
        trailingSlash: true,
        images: { unoptimized: true }
      }
    : {
        output: "standalone" as const,
        outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: `${apiInternalUrl}/api/:path*`
            }
          ];
        }
      }),
  devIndicators: false
};

export default nextConfig;
