import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
  server: {
    port: 5174,
    // Local dev talks to a local `wrangler dev` of this Worker through the same /api prefix.
    proxy: { "/api": { target: "http://127.0.0.1:8788", changeOrigin: true } },
  },
});
