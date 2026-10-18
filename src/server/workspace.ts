import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BrawlError } from "../shared/errors.js";

const SYSTEM_ROOTS = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var"
]);

export async function canonicalWorkspaceRoot(input: string): Promise<string> {
  const root = await realpath(resolve(input)).catch(() => {
    throw new BrawlError(`Configured workspace root does not exist: ${input}`, 500);
  });
  const info = await stat(root);
  if (!info.isDirectory()) throw new BrawlError("Configured workspace root must be a directory", 500);
  if (SYSTEM_ROOTS.has(root)) {
    throw new BrawlError(`Refusing unsafe configured workspace root: ${root}`, 500);
  }
  return root;
}

export async function resolveSessionWorkspace(
  rootInput: string,
  input: string,
  options: { allowRoot?: boolean } = {}
): Promise<string> {
  const root = await canonicalWorkspaceRoot(rootInput);
  if (isAbsolute(input) && SYSTEM_ROOTS.has(input)) {
    throw new BrawlError(`Refusing unsafe workspace path: ${input}`);
  }
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const real = await realpath(candidate).catch(() => {
    throw new BrawlError(`Workspace does not exist: ${input}`);
  });
  assertContained(root, real);
  const info = await stat(real);
  if (!info.isDirectory()) throw new BrawlError("Workspace must be an existing directory");
  if (!options.allowRoot && real === root) {
    // The configured root itself is allowed; this branch documents the explicit policy.
  }
  return real;
}

export async function listWorkspaceDirectories(
  rootInput: string,
  input: string
): Promise<{ path: string; directories: string[] }> {
  const root = await canonicalWorkspaceRoot(rootInput);
  const directory = await resolveSessionWorkspace(root, input, { allowRoot: true });
  const entries = await readdir(directory, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return {
    path: relative(root, directory) || ".",
    directories
  };
}

export function isContainedWorkspace(rootInput: string, candidate: string): boolean {
  const root = resolve(rootInput);
  const target = resolve(candidate);
  return target === root || target.startsWith(`${root}${sep}`);
}

function assertContained(root: string, candidate: string): void {
  if (!isContainedWorkspace(root, candidate)) {
    throw new BrawlError("Workspace must stay inside the configured workspace root");
  }
}
