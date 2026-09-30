import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/^@langfuse\//, /^@opentelemetry\//],
  dts: false,
  clean: true,
  minify: false,
  outputOptions: {
    inlineDynamicImports: true,
  },
});
