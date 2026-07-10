import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import prettierConfig from "eslint-config-prettier";

const config: Record<string, unknown>[] = [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["{src,test}/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "tsconfig.json",
        tsconfigRootDir: process.cwd(),
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...prettierConfig.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];

export default config;
