import js from "@eslint/js";
import tseslint from "typescript-eslint";

const typescriptFiles = ["**/*.ts", "**/*.tsx"];
const typescriptConfigs = tseslint.configs.recommended.map((config) => ({
  ...config,
  files: typescriptFiles,
}));
const nodeGlobals = {
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
      "**/worker-configuration.d.ts",
      "coverage/**",
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
);
