import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("WorkBuddy plugin package", () => {
  it("uses CODEBUDDY_PLUGIN_ROOT and points at the committed bundle", () => {
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const hooks = JSON.parse(fs.readFileSync(path.join(directory, "hooks/hooks.json"), "utf8"));
    const command = hooks.hooks.Stop[0].hooks[0].command as string;
    expect(command).toContain("${CODEBUDDY_PLUGIN_ROOT}");
    expect(command).toContain("dist/index.mjs");
  });
});
