import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The re-simulation worker (capa B) is a standalone CommonJS package with its
    // own package.json/node_modules and vendored Emscripten glue — not part of the
    // Next app and not covered by these rules.
    "resim/**",
    // Claude Code worktrees/planes: copias de trabajo, no código de la app.
    ".claude/**",
  ]),
]);

export default eslintConfig;
