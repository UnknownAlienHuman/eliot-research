import js from "@eslint/js";
import tseslint from "typescript-eslint";

const tsFiles = ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"];

export default tseslint.config(
  {
    ignores: ["dist/**", ".wrangler/**", "coverage/**", "apps/**", "packages/**", "scripts/**", "tests/**"],
  },
  {
    ...js.configs.recommended,
    files: ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"],
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: tsFiles })),
  {
    files: tsFiles,
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["src/client/**/*.ts", "src/client/**/*.tsx"],
    languageOptions: {
      globals: {
        document: "readonly",
        fetch: "readonly",
        location: "readonly",
        navigator: "readonly",
        window: "readonly",
      },
    },
  },
  {
    files: ["src/worker.ts"],
    languageOptions: {
      globals: {
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
      },
    },
  },
);
