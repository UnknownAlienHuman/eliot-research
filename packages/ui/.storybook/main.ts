import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-vitest"],
  core: { disableTelemetry: true },
  previewHead: (head) => `${head}<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ctext y='19' x='5'%3Ee%3C/text%3E%3C/svg%3E">`,
  async viteFinal(viteConfig) {
    return {
      ...viteConfig,
      server: { ...viteConfig.server, host: "127.0.0.1", strictPort: true },
    };
  },
};

export default config;
