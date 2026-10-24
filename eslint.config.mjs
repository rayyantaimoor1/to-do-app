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
    // Deno edge functions (npm:/jsr: specifiers) and Capacitor's generated
    // Android project aren't part of the Next build. The shared reminder
    // ladder is still linted/type-checked through src/lib/reminders.ts.
    "supabase/functions/*/**",
    "!supabase/functions/_shared/**",
    "android/**",
  ]),
]);

export default eslintConfig;
