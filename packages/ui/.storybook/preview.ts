import type { Preview } from "@storybook/react-vite";
import "../src/theme.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    controls: { expanded: true },
  },
};

export default preview;
