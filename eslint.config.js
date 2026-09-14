import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      // Underscore-prefixed names are intentionally unused (e.g. `_error` in a catch).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // stdout is the MCP protocol channel: anything written there corrupts the
      // JSON-RPC stream and disconnects the client. Log to stderr only.
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
]);
