import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectForApproval, WorkspaceTools } from "./tools.js";

describe("WorkspaceTools", () => {
  it("blocks workspace escapes and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "brawl-tools-"));
    const tools = new WorkspaceTools(root, 5_000);
    const absolute = await tools.execute("workspace_read", { path: "/etc/passwd" }, new AbortController().signal);
    expect(absolute.ok).toBe(false);
    const escape = await tools.execute("workspace_read", { path: "../outside" }, new AbortController().signal);
    expect(escape.ok).toBe(false);
  });

  it("prevents an approved write from overwriting a newer file", async () => {
    const root = await mkdtemp(join(tmpdir(), "brawl-tools-"));
    await writeFile(join(root, "file.txt"), "old");
    const tools = new WorkspaceTools(root, 5_000);
    const args = await inspectForApproval(tools, "workspace_write", {
      path: "file.txt",
      content: "new"
    });
    await writeFile(join(root, "file.txt"), "changed");
    const result = await tools.execute("workspace_write", args, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("changed");
  });
});
