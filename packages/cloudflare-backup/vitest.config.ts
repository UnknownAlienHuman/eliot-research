import { defineConfig } from "vitest/config";

// Platform transport and isolated-target checks; this is a local host runner.
export default defineConfig({ test: { include: ["src/**/*.test.ts"],
  exclude: ["**/node_modules/**", "**/dist/**"] } });
