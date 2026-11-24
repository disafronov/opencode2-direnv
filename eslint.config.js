import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TypeScript already reports undefined identifiers; the base rule does not
      // understand type-only globals.
      "no-undef": "off",
    },
  },
)
