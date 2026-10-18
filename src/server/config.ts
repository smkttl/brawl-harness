import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  AgentConfig,
  HarnessConfig,
  ProviderConfig,
  PublicHarnessConfig,
  ReasoningEffort
} from "../shared/protocol.js";
import { REASONING_EFFORTS } from "../shared/protocol.js";

export interface RuntimeOptions {
  host: string;
  port: number;
  dataDir: string;
  workspace: string;
  apiToken: string | null;
  authDisabled: boolean;
  configPath: string;
}

export interface StoredHarnessConfig extends Omit<HarnessConfig, "providers"> {
  providers: ProviderConfig[];
}

const DEFAULT_AGENTS: Record<AgentConfig["role"], AgentConfig> = {
  oracle: {
    role: "oracle",
    providerId: null,
    model: "",
    reasoningEffort: "high"
  },
  executor: {
    role: "executor",
    providerId: null,
    model: "",
    reasoningEffort: "medium"
  },
  speaker: {
    role: "speaker",
    providerId: null,
    model: "",
    reasoningEffort: "provider-default"
  }
};

const REASONING_EFFORT_SET = new Set<ReasoningEffort>(REASONING_EFFORTS);

export function resolveRuntime(overrides: Partial<RuntimeOptions> = {}): RuntimeOptions {
  const dataDir = resolve(overrides.dataDir ?? process.env.BRAWL_DATA_DIR ?? join(homedir(), ".brawl"));
  return {
    host: overrides.host ?? process.env.BRAWL_HOST ?? "127.0.0.1",
    port: overrides.port ?? Number(process.env.BRAWL_PORT ?? 8787),
    dataDir,
    workspace: resolve(overrides.workspace ?? process.env.BRAWL_WORKSPACE ?? process.cwd()),
    apiToken:
      overrides.apiToken === undefined
        ? process.env.BRAWL_API_TOKEN || null
        : overrides.apiToken,
    authDisabled:
      overrides.authDisabled ??
      (process.env.BRAWL_AUTH_DISABLED === "1" ||
        process.env.BRAWL_AUTH_DISABLED === "true"),
    configPath: resolve(overrides.configPath ?? join(dataDir, "config.yaml"))
  };
}

export class ConfigStore {
  readonly path: string;
  private value: StoredHarnessConfig;

  constructor(path: string, workspace: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.value = this.load(workspace);
  }

  get(): StoredHarnessConfig {
    return structuredClone(this.value);
  }

  save(next: StoredHarnessConfig): StoredHarnessConfig {
    this.value = validateConfig(next);
    writeFileSync(this.path, stringifyYaml(this.value), { mode: 0o600 });
    return this.get();
  }

  setProviders(providers: ProviderConfig[]): StoredHarnessConfig {
    const next = this.get();
    next.providers = providers;
    return this.save(next);
  }

  setAgent(role: AgentConfig["role"], agent: Omit<AgentConfig, "role">): StoredHarnessConfig {
    const next = this.get();
    next.agents[role] = { role, ...agent };
    return this.save(next);
  }

  setLimits(input: { debateRounds?: number; shellTimeoutMs?: number; maxRunMs?: number }): StoredHarnessConfig {
    const next = this.get();
    if (input.debateRounds !== undefined) next.debateRounds = input.debateRounds;
    if (input.shellTimeoutMs !== undefined) next.shellTimeoutMs = input.shellTimeoutMs;
    if (input.maxRunMs !== undefined) next.maxRunMs = input.maxRunMs;
    return this.save(next);
  }

  publicView(): PublicHarnessConfig {
    const next = this.get();
    const providers = next.providers.map(redactProvider);
    return { ...next, providers };
  }

  provider(id: string): ProviderConfig | null {
    return this.value.providers.find((provider) => provider.id === id) ?? null;
  }

  private load(workspace: string): StoredHarnessConfig {
    const fallback: StoredHarnessConfig = {
      providers: [],
      agents: structuredClone(DEFAULT_AGENTS),
      debateRounds: 6,
      shellTimeoutMs: 120_000,
      maxRunMs: 15 * 60_000,
      dataDir: dirname(this.path),
      workspace
    };
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, stringifyYaml(fallback), { mode: 0o600 });
      return fallback;
    }
    const parsed = parseYaml(readFileSync(this.path, "utf8")) as Partial<StoredHarnessConfig> | null;
    return validateConfig({ ...fallback, ...parsed, dataDir: dirname(this.path), workspace });
  }
}

function validateConfig(config: StoredHarnessConfig): StoredHarnessConfig {
  const agents = {} as Record<AgentConfig["role"], AgentConfig>;
  for (const role of ["oracle", "executor", "speaker"] as const) {
    const candidate = config.agents?.[role] ?? DEFAULT_AGENTS[role];
    const effort = REASONING_EFFORT_SET.has(candidate.reasoningEffort)
      ? candidate.reasoningEffort
      : "provider-default";
    agents[role] = {
      role,
      providerId: candidate.providerId || null,
      model: String(candidate.model ?? ""),
      reasoningEffort: effort
    };
  }
  return {
    providers: Array.isArray(config.providers)
      ? config.providers.map((provider) => ({
          ...provider,
          headers: provider.headers ?? {},
          models: provider.models ?? [],
          api: provider.api === "responses" ? "responses" : "chat"
        }))
      : [],
    agents,
    debateRounds:
      Number.isInteger(config.debateRounds) && config.debateRounds > 0
        ? Math.min(config.debateRounds, 30)
        : 6,
    shellTimeoutMs:
      Number.isInteger(config.shellTimeoutMs) && config.shellTimeoutMs >= 1_000
        ? config.shellTimeoutMs
        : 120_000,
    maxRunMs:
      Number.isInteger(config.maxRunMs) && config.maxRunMs >= 10_000
        ? config.maxRunMs
        : 15 * 60_000,
    dataDir: isAbsolute(config.dataDir) ? config.dataDir : dirname(config.dataDir),
    workspace: isAbsolute(config.workspace) ? config.workspace : resolve(config.workspace)
  };
}

export function redactProvider(provider: ProviderConfig): PublicHarnessConfig["providers"][number] {
  const { apiKey, headers, ...safe } = provider;
  return {
    ...safe,
    hasApiKey: Boolean(apiKey || (provider.apiKeyEnv && process.env[provider.apiKeyEnv])),
    hasHeaders: Object.keys(headers).length > 0
  };
}
