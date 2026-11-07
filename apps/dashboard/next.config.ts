import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Every page reads the login cookie and live data, so pages render per request (no Cache Components).
const nextConfig: NextConfig = {
  // A self-contained server for the Docker image (Coolify); the repo root is traced so workspace packages are included.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
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
