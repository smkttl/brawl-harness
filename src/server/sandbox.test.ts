import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectBubblewrap } from "./sandbox.js";
import { WorkspaceTools } from "./tools.js";

const bubblewrap = await inspectBubblewrap();
const probe = bubblewrap.available
  ? await new WorkspaceTools(
      await mkdtemp(join(tmpdir(), "brawl-sandbox-probe-")),
      5_000,
      "enabled"
    ).execute(
      "shell_exec",
      { command: "printf sandbox-ok" },
      new AbortController().signal
    )
  : null;
const sandboxSupported = probe?.ok === true;

describe("Bubblewrap sandbox", () => {
  it("performs a real Bubblewrap capability probe", () => {
    if (process.env.BRAWL_REQUIRE_SANDBOX === "1") {
      expect(bubblewrap.available).toBe(true);
      expect(bubblewrap.version).toContain("bubblewrap");
    } else {
      expect(typeof bubblewrap.available).toBe("boolean");
      expect(bubblewrap.available || bubblewrap.error).toBeTruthy();
    }
  });

  it.skipIf(!sandboxSupported)(
    "isolates host files, network, credentials, and system configuration",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "brawl-sandbox-"));
      const marker = `${Date.now()}-${Math.random()}`;
      const tools = new WorkspaceTools(root, 10_000, "enabled");
      const envName = `BRAWL_SANDBOX_SECRET_${marker.replace(/\W/g, "")}`;
      process.env[envName] = "must-not-leak";
      try {
        const result = await tools.execute(
          "shell_exec",
          {
            command:
              `test -z "\${${envName}:-}" && ` +
              "test ! -e /home && test ! -e /root && test ! -e /etc && " +
              "! /usr/bin/sudo -n true >/dev/null 2>&1 && " +
              "! timeout 2 /usr/bin/bash -c 'exec 3<>/dev/tcp/1.1.1.1/80' 2>/dev/null && " +
              "printf isolated > credential.txt",
            timeoutMs: 5_000
          },
          new AbortController().signal
        );
        expect(result.ok).toBe(true);
        expect(await readFile(join(root, "credential.txt"), "utf8")).toBe("isolated");
      } finally {
        delete process.env[envName];
      }
    }
  );

  it.skipIf(!sandboxSupported)("preserves workspace reads and writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "brawl-sandbox-"));
    await writeFile(join(root, "input.txt"), "before");
    const tools = new WorkspaceTools(root, 10_000, "enabled");
    const result = await tools.execute(
      "shell_exec",
      { command: "printf after > output.txt && cat input.txt" },
      new AbortController().signal
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("before");
    expect(await readFile(join(root, "output.txt"), "utf8")).toBe("after");
  });

  it.skipIf(!sandboxSupported)("enforces timeout and abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "brawl-sandbox-"));
    const tools = new WorkspaceTools(root, 10_000, "enabled");
    const timed = await tools.execute(
      "shell_exec",
      { command: "sleep 5", timeoutMs: 1_000 },
      new AbortController().signal
    );
    expect(timed.data?.timedOut).toBe(true);

    const controller = new AbortController();
    const pending = tools.execute(
      "shell_exec",
      { command: "sleep 5" },
      controller.signal
    );
    controller.abort(new Error("test abort"));
    const aborted = await pending;
    expect(aborted.ok).toBe(false);
  });
});
