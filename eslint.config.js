export default [
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {},
    },
    rules: {
      // Start with project defaults; keep empty to inherit ESLint defaults.
    },
  },
];
