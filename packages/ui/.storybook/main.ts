import type { StorybookConfig } from "@storybook/react-vite";
import { createRequire } from "node:module";

const appRequire = createRequire(new URL("../../../apps/eliotr-web/package.json", import.meta.url));
const routerEntry = appRequire.resolve("react-router");

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.tsx", "../../../apps/eliotr-web/src/app/Shell.stories.tsx"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-vitest"],
  core: { disableTelemetry: true },
  previewHead: (head) => `${head}<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ctext y='19' x='5'%3Ee%3C/text%3E%3C/svg%3E">`,
  async viteFinal(viteConfig) {
    return {
      ...viteConfig,
      server: { ...viteConfig.server, host: "127.0.0.1", strictPort: true },
      resolve: { ...viteConfig.resolve, alias: [{ find: "react-router", replacement: routerEntry }, ...(Array.isArray(viteConfig.resolve?.alias) ? viteConfig.resolve.alias : Object.entries(viteConfig.resolve?.alias ?? {}).map(([find, replacement]) => ({ find, replacement })))] },
      optimizeDeps: { ...viteConfig.optimizeDeps, include: [...(viteConfig.optimizeDeps?.include ?? []), "react-router"] },
    };
  },
};

export default config;
