import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/require-await": "off",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-restricted-globals": ["error", "process", "Buffer"],
    },
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.mjs", "vite.config.ts", "vitest.config.ts"],
    languageOptions: { globals: { process: "readonly", Buffer: "readonly" } },
    rules: { "no-console": "off" },
  },
);
