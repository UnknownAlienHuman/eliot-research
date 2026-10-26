import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      configPath: "./wrangler.jsonc",
      remoteBindings: process.env.ELIOT_REMOTE_BINDINGS !== "0",
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    sourcemap: false,
  },
});
