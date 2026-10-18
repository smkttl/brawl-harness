import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalWorkspaceRoot,
  listWorkspaceDirectories,
  resolveSessionWorkspace
} from "./workspace.js";

describe("workspace containment", () => {
  it("allows only the configured root and its descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "brawl-workspace-"));
    const child = join(root, "child");
    const outside = await mkdtemp(join(tmpdir(), "brawl-outside-"));
    await mkdir(child);
    await symlink(outside, join(root, "escape"));

    await expect(canonicalWorkspaceRoot(root)).resolves.toBe(root);
    await expect(resolveSessionWorkspace(root, child)).resolves.toBe(child);
    await expect(resolveSessionWorkspace(root, outside)).rejects.toThrow(
      "inside the configured workspace root"
    );
    await expect(resolveSessionWorkspace(root, "escape")).rejects.toThrow(
      "inside the configured workspace root"
    );
    await expect(canonicalWorkspaceRoot("/")).rejects.toThrow(
      "Refusing unsafe configured workspace root"
    );
  });

  it("lists only contained directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "brawl-workspace-"));
    const child = join(root, "child");
    const outside = await mkdtemp(join(tmpdir(), "brawl-outside-"));
    await mkdir(child);
    await symlink(outside, join(root, "linked"));

    await expect(listWorkspaceDirectories(root, ".")).resolves.toEqual({
      path: ".",
      directories: ["child"]
    });
  });
});
