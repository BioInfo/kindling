import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node:sqlite is a built-in; mark it external so the bundler leaves it alone.
  serverExternalPackages: ["node:sqlite"],
};

export default nextConfig;
