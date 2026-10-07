import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import gdp from "@gdp-ts/core/lint/eslint";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // gdp-ts (Ghosts of Departed Proofs): proofs are minted only in src/server/proofs, never exported as provers,
  // never forged with `as`; on the server's authorization path, no `as` or `any` at all (branded ids are made in
  // src/lib/ids.ts, the signed-in user's in src/server/auth.ts)
  ...gdp({ proofs: ["src/server/proofs/**"] }),
  ...gdp({
    proofs: ["src/server/proofs/**"], strict: true,
    files: ["src/server/{actions,auth-actions,queries,auth}.ts", "src/server/data/**/*.ts", "src/server/proofs/**/*.ts", "src/app/api/**/*.ts", "src/app/**/page.tsx", "src/lib/ids.ts"],
    allowAssertions: ["src/lib/ids.ts", "src/server/auth.ts"],
  }),
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // `interface X<P> extends Proof<"X", [P]> {}` is the proof recipe
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],
      // proofs are often unused at runtime: named `_proof`
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
