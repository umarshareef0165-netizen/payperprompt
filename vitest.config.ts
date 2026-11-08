import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Resolves the "@/..." import alias (same mapping as tsconfig.json)
// so route-handler tests can import the app code under test.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(fileURLToPath(new URL(".", import.meta.url))),
    },
  },
});
