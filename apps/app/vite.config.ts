import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
  server: {
    port: 5173,
    // Local dev talks to the live partner API through the same /api prefix the Worker serves in production.
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
});
