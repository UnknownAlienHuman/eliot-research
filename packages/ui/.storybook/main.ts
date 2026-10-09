import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-a11y"],
  core: { disableTelemetry: true },
  async viteFinal(viteConfig) {
    return {
      ...viteConfig,
      server: { ...viteConfig.server, host: "127.0.0.1", strictPort: true },
    };
  },
};

export default config;
