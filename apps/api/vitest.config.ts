import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  // `cloudflare:workers` exists only in workerd; the tests get a stub with the same shape.
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)) } },
});
