import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface BubblewrapCapabilities {
  available: boolean;
  version: string | null;
  error: string | null;
}

const BWRAP_PATH = "/usr/bin/bwrap";
const RUNTIME_ROOTS = ["/usr", "/lib", "/lib64"] as const;

export class BubblewrapSandbox {
  private readonly workspace: string;
  private readonly timeoutMs: number;

  constructor(workspace: string, timeoutMs: number) {
    this.workspace = resolve(workspace);
    this.timeoutMs = timeoutMs;
  }

  async run(
    command: string,
    timeoutOverride: unknown,
    signal: AbortSignal
  ): Promise<SandboxRunResult> {
    signal.throwIfAborted();
    const workspace = await realpath(this.workspace).catch(() => {
      throw new Error(`Sandbox workspace does not exist: ${this.workspace}`);
    });
    signal.throwIfAborted();
    const timeoutMs = boundedTimeout(timeoutOverride, this.timeoutMs);
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--uid",
      "0",
      "--gid",
      "0",
      "--cap-drop",
      "ALL",
      ...RUNTIME_ROOTS.flatMap((root) => ["--ro-bind", root, root]),
      "--bind",
      workspace,
      "/workspace",
      "--tmpfs",
      "/tmp",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--chdir",
      "/workspace",
      "/usr/bin/bash",
      "-c",
      command
    ];

    return runProcess(BWRAP_PATH, args, this.workspace, timeoutMs, signal);
  }
}

export async function inspectBubblewrap(): Promise<BubblewrapCapabilities> {
  const version = await bubblewrapVersion().catch((error) => ({
    available: false,
    version: null,
    error: error instanceof Error ? error.message : String(error)
  }));
  if (!version.available) return version;
  const probeRoot = await mkdtemp(join(tmpdir(), "brawl-bwrap-capability-"));
  try {
    const probe = await new BubblewrapSandbox(probeRoot, 5_000).run(
      "printf bwrap-ready",
      "1000",
      new AbortController().signal
    );
    if (probe.code !== 0 || probe.stdout !== "bwrap-ready") {
      return {
        available: false,
        version: version.version,
        error:
          probe.stderr.trim() ||
          "Bubblewrap is installed but cannot create the required isolated namespaces"
      };
    }
  } catch (error) {
    return {
      available: false,
      version: version.version,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
  return {
    available: true,
    version: version.version,
    error: null
  };
}

async function bubblewrapVersion(): Promise<BubblewrapCapabilities> {
  try {
    await access(BWRAP_PATH, constants.X_OK);
  } catch {
    return {
      available: false,
      version: null,
      error: "Bubblewrap is not installed at /usr/bin/bwrap"
    };
  }
  const version = await runProcess(
    BWRAP_PATH,
    ["--version"],
    process.cwd(),
    5_000,
    new AbortController().signal
  );
  if (version.code !== 0) {
    return {
      available: false,
      version: null,
      error: version.stderr || "Bubblewrap version check failed"
    };
  }
  return {
    available: true,
    version: [version.stdout, version.stderr].filter(Boolean).join(" ").trim() || null,
    error: null
  };
}

function boundedTimeout(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(1_000, Math.min(fallback, Math.floor(number)))
    : fallback;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<SandboxRunResult> {
  signal.throwIfAborted();
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const append = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString("utf8")}`.slice(0, 150_000);
    const finish = (result: SandboxRunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolvePromise(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const terminate = () => {
      signalGroup(child.pid, "SIGTERM");
      setTimeout(() => {
        signalGroup(child.pid, "SIGKILL");
      }, 2_000).unref();
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const abort = () => terminate();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      finish({
        stdout,
        stderr: [stderr, error.message].filter(Boolean).join("\n"),
        code: null,
        timedOut
      });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code, timedOut });
    });
  });
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
