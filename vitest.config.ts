import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Component tests (ticket #269): React components rendered in jsdom with Testing Library, `src/**/*.test.tsx`. `npm run ui:check`
// (and `npm test`, which runs every check) runs them once; `npx vitest` keeps watching.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  // (subjecto ships without its source maps: vite warned of each, every run)
  logLevel: "error",
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
