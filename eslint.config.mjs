import js from "@eslint/js";
import tseslint from "typescript-eslint";

const typescriptFiles = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const typescriptConfigs = tseslint.configs.recommended.map((config) => ({
  ...config,
  files: typescriptFiles,
}));
const nodeGlobals = {
  AbortSignal: "readonly",
  Response: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URLSearchParams: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-types/**",
      "**/.wrangler/**",
      "**/.astro/**",
      "**/worker-configuration.d.ts",
      "coverage/**",
      ".eliotr-state/**",
      "apps/eliotr-pwa/public/agent-inbox/app.js",
    ],
  },
  js.configs.recommended,
  ...typescriptConfigs,
  {
    files: typescriptFiles,
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/require-await": "off",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-control-regex": "off",
      "no-restricted-globals": ["error", "process", "Buffer"],
    },
  },
  {
    files: [
      "scripts/**/*.mjs",
      "integrations/**/*.mjs",
      "eslint.config.mjs",
      "**/vite.config.ts",
      "**/vitest.config.ts",
    ],
    languageOptions: { globals: nodeGlobals },
    rules: {
      "no-console": "off",
      "no-control-regex": "off",
    },
  },
  {
    files: ["apps/eliotr-pwa/public/sw.js"],
    languageOptions: {
      globals: {
        URL: "readonly",
        caches: "readonly",
        fetch: "readonly",
        self: "readonly",
      },
    },
  },
  {
    files: ["packages/owner-api-client/src/**/*.ts"],
    languageOptions: {
      globals: { window: "readonly", document: "readonly", navigator: "readonly", localStorage: "readonly", sessionStorage: "readonly", location: "readonly" },
    },
    rules: {
      "no-restricted-globals": ["error", "window", "document", "navigator", "localStorage", "sessionStorage", "location", "Worker", "EventSource", "WebSocket"],
    },
  },
  {
    // Owner-web and UI are browser TypeScript/TSX and are not covered by the
    // Node-only exception above. The DOM lib comes from tsconfig; ESLint still
    // needs the globals declared or every React file is flagged as undefined.
    // Browser globals belong to source only. The root Vite configs keep the
    // Node ambient guard above and are intentionally not matched here.
    files: ["apps/eliotr-web/src/**/*.ts", "apps/eliotr-web/src/**/*.tsx", "packages/ui/src/**/*.ts", "packages/ui/src/**/*.tsx"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        CustomEvent: "readonly",
        Document: "readonly",
        Element: "readonly",
        Event: "readonly",
        EventTarget: "readonly",
        HTMLElement: "readonly",
        IntersectionObserver: "readonly",
        MutationObserver: "readonly",
        Node: "readonly",
        ResizeObserver: "readonly",
        URL: "readonly",
        Window: "readonly",
        console: "readonly",
        crypto: "readonly",
        document: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
        location: "readonly",
        navigator: "readonly",
        requestAnimationFrame: "readonly",
        sessionStorage: "readonly",
        window: "readonly",
      },
    },
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-restricted-globals": ["error", "process", "Buffer"],
    },
  },
);
