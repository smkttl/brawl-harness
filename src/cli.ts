#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { resolveRuntime } from "./server/config.js";
import { HarnessClient } from "./client/api.js";
import type { Mode, SandboxMode } from "./shared/protocol.js";

const program = new Command()
  .name("brawl")
  .description("Three-agent local coding harness")
  .version("0.1.0");

program
  .command("server")
  .argument("<action>", "start, stop, or status")
  .option("-d, --detach", "run the backend in the background")
  .option("--workspace <path>", "default workspace", process.cwd())
  .option("--port <number>", "backend port", "8787")
  .action(async (action: string, options: { detach?: boolean; workspace: string; port: string }) => {
    const runtime = resolveRuntime({
      workspace: options.workspace,
      port: Number(options.port)
    });
    const pidPath = join(runtime.dataDir, "server.pid");
    if (action === "status") {
      const pid = readPid(pidPath);
      console.log(pid ? `running (pid ${pid}) · http://${runtime.host}:${runtime.port}` : "stopped");
      return;
    }
    if (action === "stop") {
      const pid = readPid(pidPath);
      if (!pid) {
        console.log("stopped");
        return;
      }
      process.kill(pid, "SIGTERM");
      rmSync(pidPath, { force: true });
      console.log(`stopped pid ${pid}`);
      return;
    }
    if (action !== "start") throw new Error("Expected start, stop, or status");
    mkdirSync(runtime.dataDir, { recursive: true });
    const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "server/index.js");
    const args = serverEntry;
    const env = {
      ...process.env,
      BRAWL_HOST: runtime.host,
      BRAWL_PORT: String(runtime.port),
      BRAWL_DATA_DIR: runtime.dataDir,
      BRAWL_WORKSPACE: runtime.workspace
    };
    if (!options.detach) {
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(process.execPath, [args], { stdio: "inherit", env });
        child.once("exit", (code) =>
          code === 0 ? resolvePromise() : reject(new Error(`Backend exited with ${code}`))
        );
      });
      return;
    }
    const logPath = join(runtime.dataDir, "server.log");
    const out = openSync(logPath, "a");
    const child = spawn(process.execPath, [args], {
      detached: true,
      stdio: ["ignore", out, out],
      env
    });
    child.unref();
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(pidPath, String(child.pid)));
    console.log(`started pid ${child.pid} · http://${runtime.host}:${runtime.port}`);
  });

program
  .command("tui")
  .option("--session <id>", "attach to a session")
  .option("--url <url>", "backend URL", "http://127.0.0.1:8787")
  .action(async (options: { session?: string; url: string }) => {
    const token = accessToken();
    const { runTui } = await import("./tui/main.js");
    runTui({
      client: new HarnessClient({ baseUrl: options.url, token }),
      ...(options.session ? { initialSessionId: options.session } : {})
    });
  });

program
  .command("chat")
  .argument("[message...]", "opening message")
  .option("--mode <mode>", "productive or fun", "productive")
  .option("--sandbox <mode>", "enabled, disabled, or auto-review", "enabled")
  .option("--workspace <path>", "workspace", process.cwd())
  .option("--url <url>", "backend URL", "http://127.0.0.1:8787")
  .action(async (
    words: string[],
    options: { mode: Mode; sandbox: SandboxMode; workspace: string; url: string }
  ) => {
    const client = new HarnessClient({ baseUrl: options.url, token: accessToken() });
    const detail = await client.createSession({
      mode: options.mode,
      sandboxMode: options.sandbox,
      workspace: resolve(options.workspace)
    });
    if (words.length) await client.send(detail.session.id, words.join(" "));
    console.log(detail.session.id);
  });

program
  .command("sessions")
  .option("--url <url>", "backend URL", "http://127.0.0.1:8787")
  .action(async (options: { url: string }) => {
    const client = new HarnessClient({ baseUrl: options.url, token: accessToken() });
    for (const session of await client.sessions()) {
      console.log(
        `${session.id}  ${session.status.padEnd(18)} ${session.mode.padEnd(10)} ` +
          `${session.sandboxMode.padEnd(12)} ${session.title}`
      );
    }
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

function readPid(path: string): number | null {
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isInteger(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function accessToken(): string {
  const token = process.env.BRAWL_API_TOKEN;
  if (!token) throw new Error("Set BRAWL_API_TOKEN before connecting to the backend");
  return token;
}

void homedir;
