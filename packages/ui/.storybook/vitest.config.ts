import { env } from "node:process";
import { defineConfig } from "vitest/config";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";

const executablePath = env.ELIOT_UI_BROWSER_EXECUTABLE?.trim();

export default defineConfig({
  plugins: [storybookTest({ configDir: import.meta.dirname })],
  server: { host: "127.0.0.1", strictPort: true },
  test: {
    name: "storybook",
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}),
      instances: [{ browser: "chromium" }],
    },
    setupFiles: [".storybook/vitest.setup.ts"],
  },
});
