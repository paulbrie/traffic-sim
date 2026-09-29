import type { NextConfig } from "next";

// Serve the app under a sub-path (e.g. "/trafficsim"). Empty by default; read at build time and
// inlined into client code (see src/lib/base-path.ts), so changing it needs a rebuild / dev restart.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  basePath,
  // the public host of a remote dev server (behind a proxy), so hot reload works from the browser
  allowedDevOrigins: process.env.PUBLIC_HOST ? [process.env.PUBLIC_HOST] : [],
  experimental: {
    // autosave sends the whole plan; imported districts with thousands of buildings run to a few MB
    serverActions: { bodySizeLimit: "40mb" },
  },
};

export default nextConfig;
