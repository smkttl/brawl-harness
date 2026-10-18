import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolName } from "../shared/protocol.js";
import { BrawlError } from "../shared/errors.js";
import { BubblewrapSandbox } from "./sandbox.js";

export interface ToolResult {
  ok: boolean;
  output: string;
  data?: Record<string, unknown>;
}

export class WorkspaceTools {
  readonly root: string;
  private readonly timeoutMs: number;
  private readonly sandbox: "enabled" | "disabled" | null;

  constructor(
    root: string,
    timeoutMs: number,
    sandbox: "enabled" | "disabled" | null = null
  ) {
    this.root = resolve(root);
    this.timeoutMs = timeoutMs;
    this.sandbox = sandbox;
  }

  async execute(
    action: ToolName,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ToolResult> {
    try {
      switch (action) {
        case "workspace_list":
          return await this.list(args, signal);
        case "workspace_read":
          return await this.read(args, signal);
        case "workspace_search":
          return await this.search(args, signal);
        case "workspace_write":
          return await this.write(args, signal);
        case "workspace_patch":
          return await this.patch(args, signal);
        case "shell_exec":
          return await this.shell(args, signal);
      }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error)
      };
    }
  }

  digest(action: ToolName, args: Record<string, unknown>): string {
    return createHash("sha256")
      .update(action)
      .update("\0")
      .update(stableStringify(args))
      .digest("hex");
  }

  private async list(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    this.checkSignal(signal);
    const path = await this.safePath(stringArg(args.path, "."));
    const entries = await readdir(path, { withFileTypes: true });
    const limit = boundedInteger(args.limit, 200, 1, 2_000);
    const rows = entries
      .filter((entry) => !["node_modules", ".git"].includes(entry.name))
      .slice(0, limit)
      .map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`);
    return { ok: true, output: rows.join("\n"), data: { count: rows.length } };
  }

  private async read(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    this.checkSignal(signal);
    const path = await this.safePath(requiredString(args.path, "path"));
    const content = await readFile(path, "utf8");
    const maxChars = boundedInteger(args.maxChars, 60_000, 100, 250_000);
    const truncated = content.length > maxChars;
    return {
      ok: true,
      output: truncated ? `${content.slice(0, maxChars)}\n[truncated]` : content,
      data: { path: relative(this.root, path), truncated }
    };
  }

  private async search(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    this.checkSignal(signal);
    const query = requiredString(args.query, "query");
    if (query.length > 500) throw new BrawlError("Search query is too long");
    const path = await this.safePath(stringArg(args.path, "."));
    const limit = boundedInteger(args.limit, 100, 1, 500);
    const result = await runProcess(
      "rg",
      ["-n", "--hidden", "-g", "!node_modules/**", "-g", "!.git/**", "--", query, path],
      this.root,
      Math.min(this.timeoutMs, 30_000),
      signal
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new BrawlError(result.stderr || `rg exited with ${result.code}`);
    }
    const lines = result.stdout.split("\n").filter(Boolean).slice(0, limit).map((line) =>
      line.startsWith(`${this.root}${sep}`) ? line.slice(this.root.length + 1) : line
    );
    return { ok: true, output: lines.join("\n"), data: { count: lines.length } };
  }

  private async write(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    this.checkSignal(signal);
    const path = await this.safePath(requiredString(args.path, "path"), true);
    const content = requiredString(args.content, "content", true);
    const expected = args.expectedSha256 ? String(args.expectedSha256) : null;
    const current = await fileHashOrNull(path);
    if (expected && expected !== current) {
      return { ok: false, output: "File changed since approval; create a fresh proposal." };
    }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.brawl-${process.pid}-${Date.now()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
    return {
      ok: true,
      output: `Wrote ${relative(this.root, path)} (${Buffer.byteLength(content)} bytes)`,
      data: { path: relative(this.root, path), sha256: await fileHashOrNull(path) }
    };
  }

  private async patch(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    this.checkSignal(signal);
    const patch = requiredString(args.patch, "patch", true);
    if (!patch.startsWith("*** Begin Patch\n") || !patch.endsWith("\n*** End Patch")) {
      throw new BrawlError("Patch must use the *** Begin Patch / *** End Patch envelope");
    }
    const expected = Array.isArray(args.expectedHashes)
      ? (args.expectedHashes as Array<{ path?: string; sha256?: string }>)
      : [];
    for (const item of expected) {
      if (!item.path) continue;
      const path = await this.safePath(item.path);
      if ((await fileHashOrNull(path)) !== (item.sha256 ?? "")) {
        return { ok: false, output: `File changed since approval: ${item.path}` };
      }
    }
    // apply_patch is intentionally a trusted local action executed in the approved workspace.
    const result = await runProcess(
      "/bin/bash",
      [
        "-lc",
        "if command -v apply_patch >/dev/null 2>&1; then exec apply_patch \"$1\"; " +
          "elif command -v codex >/dev/null 2>&1; then exec codex apply-patch \"$1\"; " +
          "else printf '%s\\n' 'apply_patch is unavailable; use workspace_write or shell_exec' >&2; exit 127; fi",
        "_",
        patch
      ],
      this.root,
      Math.min(this.timeoutMs, 60_000),
      signal
    );
    return {
      ok: result.code === 0,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n")
    };
  }

  private async shell(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    this.checkSignal(signal);
    const command = requiredString(args.command, "command");
    const timeoutMs = boundedInteger(args.timeoutMs, this.timeoutMs, 1_000, this.timeoutMs);
    if (this.sandbox === "enabled") {
      const result = await new BubblewrapSandbox(this.root, this.timeoutMs).run(
        command,
        timeoutMs,
        signal
      );
      return this.shellResult(result.stdout, result.stderr, result.code, result.timedOut);
    }
    const result = await runProcess("/bin/bash", ["-lc", command], this.root, timeoutMs, signal);
    return this.shellResult(result.stdout, result.stderr, result.code, result.timedOut);
  }

  private async shellResult(
    stdout: string,
    stderr: string,
    code: number | null,
    timedOut: boolean
  ): Promise<ToolResult> {
    const output = [stdout, stderr].filter(Boolean).join("\n").slice(0, 100_000);
    return {
      ok: code === 0,
      output: output || `(no output; exit ${code ?? "signal"})`,
      data: { exitCode: code, timedOut }
    };
  }

  private async safePath(input: string, allowMissing = false): Promise<string> {
    if (isAbsolute(input)) throw new BrawlError("Absolute paths are not allowed");
    const candidate = resolve(this.root, input);
    if (candidate !== this.root && !candidate.startsWith(`${this.root}${sep}`)) {
      throw new BrawlError("Path escapes the configured workspace");
    }
    try {
      const real = await realpath(candidate);
      if (real !== this.root && !real.startsWith(`${this.root}${sep}`)) {
        throw new BrawlError("Symlink escapes the configured workspace");
      }
      return real;
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let parent = dirname(candidate);
      while (parent !== this.root) {
        try {
          const real = await realpath(parent);
          if (real !== this.root && !real.startsWith(`${this.root}${sep}`)) {
            throw new BrawlError("Symlink escapes the configured workspace");
          }
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          parent = dirname(parent);
        }
      }
      return candidate;
    }
  }

  private checkSignal(signal: AbortSignal): void {
    signal.throwIfAborted();
  }
}

export async function inspectForApproval(
  tools: WorkspaceTools,
  action: ToolName,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (action === "workspace_write") {
    const target = String(args.path ?? "");
    try {
      const content = await readFile(resolve(tools.root, target), "utf8");
      return { ...args, expectedSha256: sha256(content) };
    } catch {
      return { ...args, expectedSha256: "" };
    }
  }
  if (action === "workspace_patch") {
    const paths = [...String(args.patch ?? "").matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(
      (match) => match[1] as string
    );
    const expectedHashes = [];
    for (const path of [...new Set(paths)]) {
      try {
        const content = await readFile(resolve(tools.root, path), "utf8");
        expectedHashes.push({ path, sha256: sha256(content) });
      } catch {
        expectedHashes.push({ path, sha256: "" });
      }
    }
    return { ...args, expectedHashes };
  }
  return args;
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  signal.throwIfAborted();
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString("utf8")}`.slice(0, 150_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child.pid, "SIGTERM");
      setTimeout(() => signalProcessGroup(child.pid, "SIGKILL"), 2_000).unref();
    }, timeoutMs);
    const abort = () => {
      signalProcessGroup(child.pid, "SIGTERM");
      setTimeout(() => signalProcessGroup(child.pid, "SIGKILL"), 2_000).unref();
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolvePromise({ stdout, stderr: `${stderr}\n${error.message}`.trim(), code: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolvePromise({ stdout, stderr, code, timedOut });
    });
  });
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function fileHashOrNull(path: string): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return "";
    return sha256(await readFile(path));
  } catch {
    return "";
  }
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value)) {
    throw new BrawlError(`${name} must be a non-empty string`);
  }
  return value;
}

function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}
