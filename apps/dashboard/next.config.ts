import type { NextConfig } from "next";

// Every page reads the login cookie and live data, so pages render per request (no Cache Components).
const nextConfig: NextConfig = {
  transpilePackages: ["@basivo-factory/core", "@basivo-factory/trackers"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
