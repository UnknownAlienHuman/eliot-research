import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(() => {
  if (process.env.CLOUDFLARE_ENV !== "test") {
    throw new Error("Owner-web integration requires CLOUDFLARE_ENV=test.");
  }
  return {
    plugins: [
      react(),
      cloudflare({ configPath: "../eliotr-core/wrangler.jsonc", remoteBindings: false }),
      tailwindcss(),
    ],
    server: { host: "127.0.0.1", port: 5174, strictPort: true },
    build: { sourcemap: false },
  };
});
