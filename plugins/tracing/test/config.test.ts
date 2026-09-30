import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getConfig } from "../src/config.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("configuration", () => {
  it("resolves global, project, then WorkBuddy-specific environment values", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-litefuse-"));
    temporary.push(root);
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await fs.mkdir(path.join(home, ".workbuddy"), { recursive: true });
    await fs.mkdir(path.join(cwd, ".workbuddy"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".workbuddy", "litefuse.json"),
      JSON.stringify({ enabled: true, public_key: "global", max_chars: 100 }),
    );
    await fs.writeFile(
      path.join(cwd, ".workbuddy", "litefuse.json"),
      JSON.stringify({ public_key: "project", tags: ["project"] }),
    );

    const config = await getConfig({
      home,
      cwd,
      env: {
        LITEFUSE_PUBLIC_KEY: "standard",
        LITEFUSE_WORKBUDDY_PUBLIC_KEY: "workbuddy",
        LITEFUSE_WORKBUDDY_SECRET_KEY: "secret",
        LITEFUSE_WORKBUDDY_TAGS: "one,two",
      },
    });
    expect(config.enabled).toBe(true);
    expect(config.public_key).toBe("workbuddy");
    expect(config.secret_key).toBe("secret");
    expect(config.tags).toEqual(["one", "two"]);
    expect(config.max_chars).toBe(100);
  });

  it("defaults to a self-hosted Litefuse endpoint and stays disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-litefuse-defaults-"));
    temporary.push(root);
    const config = await getConfig({ home: root, cwd: root, env: {} });
    expect(config.enabled).toBe(false);
    expect(config.base_url).toBe("http://localhost:3000");
    expect(config.max_chars).toBe(20_000);
  });
});
