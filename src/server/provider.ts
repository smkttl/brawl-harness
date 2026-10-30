import {
  REASONING_EFFORTS,
  type AgentConfig,
  type ProviderConfig,
  type ToolName
} from "../shared/protocol.js";
import { BrawlError } from "../shared/errors.js";
import { createSseParser } from "../shared/stream.js";

export type ProviderMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; toolName: string };

export interface ProviderTool {
  name:
    | ToolName
    | "send_steer"
    | "submit_plan"
    | "submit_work_order"
    | "submit_review"
    | "cast_vote"
    | "ask_user";
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelReply {
  text: string;
  reasoningSummary: string | null;
  toolCalls: ToolCall[];
  usage: { input: number; output: number; reasoning: number };
  finishReason: string | null;
}

export interface ModelRequest {
  provider: ProviderConfig;
  config: AgentConfig;
  messages: ProviderMessage[];
  tools: ProviderTool[];
  signal: AbortSignal;
  onDelta: (kind: "text" | "reasoning", delta: string) => void;
}

export async function complete(request: ModelRequest): Promise<ModelReply> {
  if (!request.config.model) throw new BrawlError("No model configured for this agent", 409);
  const result = request.provider.api === "responses"
    ? completeResponses(request)
    : completeChat(request);
  return result;
}

export async function discoverModels(provider: ProviderConfig): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(endpoint(provider, "models"), {
      headers: requestHeaders(provider),
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BrawlError(`Model discovery request failed: ${reason}`, 502);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
    throw new BrawlError(
      `Model discovery failed (${response.status})${detail ? `: ${detail}` : ""}`,
      502
    );
  }
  let body: {
    data?: Array<{ id?: string }>;
    models?: Array<{ id?: string; name?: string }>;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new BrawlError("Model discovery returned invalid JSON", 502);
  }
  const ids = [
    ...(Array.isArray(body.data) ? body.data.map((model) => model?.id) : []),
    ...(Array.isArray(body.models)
      ? body.models.map((model) => model?.id ?? model?.name)
      : [])
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)].sort();
}

async function completeChat(request: ModelRequest): Promise<ModelReply> {
  const body: Record<string, unknown> = {
    model: request.config.model,
    messages: toChatMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true }
  };
  const tools = request.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
  if (tools.length > 0) body.tools = tools;
  if (request.config.reasoningEffort !== "provider-default") {
    body.reasoning_effort = request.config.reasoningEffort;
  }
  const response = await fetch(endpoint(request.provider, "chat/completions"), {
    method: "POST",
    headers: requestHeaders(request.provider),
    body: JSON.stringify(body),
    signal: request.signal
  });
  if (!response.ok) {
    throw new BrawlError(
      `Provider request failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
      502
    );
  }
  if (!response.body) throw new BrawlError("Provider returned no response body", 502);

  const state = emptyReplyState();
  for await (const event of sse(response.body, request.signal)) {
    if (event === "[DONE]") break;
    let chunk: any;
    try {
      chunk = JSON.parse(event);
    } catch {
      continue;
    }
    if (chunk.usage) addUsage(state, chunk.usage);
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (delta.content) {
        state.text += String(delta.content);
        request.onDelta("text", String(delta.content));
      }
      for (const call of delta.tool_calls ?? []) {
        const index = Number(call.index ?? 0);
        const target = (state.calls[index] ??= {
          id: String(call.id ?? `call-${index}`),
          name: "",
          arguments: ""
        });
        if (call.id) target.id = String(call.id);
        if (call.function?.name) target.name += String(call.function.name);
        if (call.function?.arguments) target.arguments += String(call.function.arguments);
      }
      if (choice.finish_reason) state.finishReason = String(choice.finish_reason);
    }
  }
  return finalizeReply(state);
}

async function completeResponses(request: ModelRequest): Promise<ModelReply> {
  const body: Record<string, unknown> = {
    model: request.config.model,
    input: toResponsesInput(request.messages),
    stream: true,
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false
    }))
  };
  if (request.config.reasoningEffort !== "provider-default") {
    body.reasoning = { effort: request.config.reasoningEffort, summary: "auto" };
  } else {
    body.reasoning = { summary: "auto" };
  }
  const response = await fetch(endpoint(request.provider, "responses"), {
    method: "POST",
    headers: requestHeaders(request.provider),
    body: JSON.stringify(body),
    signal: request.signal
  });
  if (!response.ok) {
    throw new BrawlError(
      `Provider request failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
      502
    );
  }
  if (!response.body) throw new BrawlError("Provider returned no response body", 502);

  const state = emptyReplyState();
  const calls = new Map<string, { name: string; arguments: string }>();
  for await (const event of sse(response.body, request.signal)) {
    if (event === "[DONE]") break;
    let chunk: any;
    try {
      chunk = JSON.parse(event);
    } catch {
      continue;
    }
    const type = String(chunk.type ?? "");
    if (type === "response.output_text.delta" && chunk.delta) {
      state.text += String(chunk.delta);
      request.onDelta("text", String(chunk.delta));
    }
    if (type.includes("reasoning_summary_text.delta") && chunk.delta) {
      state.reasoningSummary = (state.reasoningSummary ?? "") + String(chunk.delta);
      request.onDelta("reasoning", String(chunk.delta));
    }
    if (type === "response.output_item.added" && chunk.item?.type === "function_call") {
      calls.set(String(chunk.item.id ?? chunk.item.call_id), {
        name: String(chunk.item.name ?? ""),
        arguments: ""
      });
    }
    if (type === "response.function_call_arguments.delta") {
      const call = calls.get(String(chunk.item_id));
      if (call) call.arguments += String(chunk.delta ?? "");
    }
    if (type === "response.completed" && chunk.response?.usage) {
      addUsage(state, chunk.response.usage);
      state.finishReason = "stop";
    }
    if (type === "response.failed") {
      throw new BrawlError(String(chunk.response?.error?.message ?? "Response failed"), 502);
    }
  }
  for (const [id, call] of calls) {
    state.calls.push({ id, name: call.name, arguments: call.arguments });
  }
  request.signal.throwIfAborted();
  return finalizeReply(state);
}

function emptyReplyState() {
  return {
    text: "",
    reasoningSummary: null as string | null,
    calls: [] as ToolCall[],
    usage: { input: 0, output: 0, reasoning: 0 },
    finishReason: null as string | null
  };
}

function addUsage(state: ReturnType<typeof emptyReplyState>, usage: any): void {
  state.usage.input = Number(usage.input_tokens ?? usage.prompt_tokens ?? state.usage.input);
  state.usage.output = Number(
    usage.output_tokens ?? usage.completion_tokens ?? state.usage.output
  );
  state.usage.reasoning = Number(
    usage.output_tokens_details?.reasoning_tokens ??
      usage.completion_tokens_details?.reasoning_tokens ??
      state.usage.reasoning
  );
}

function finalizeReply(state: ReturnType<typeof emptyReplyState>): ModelReply {
  return {
    text: state.text,
    reasoningSummary: state.reasoningSummary,
    toolCalls: state.calls.filter((call) => call.name),
    usage: state.usage,
    finishReason: state.finishReason
  };
}

function toChatMessages(messages: ProviderMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: message.content
      };
    }
    return {
      role: message.role,
      content: message.content,
      ...(message.role === "assistant" && message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments }
            }))
          }
        : {})
    };
  });
}

function toResponsesInput(messages: ProviderMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (message.role === "tool") {
      const output: Record<string, unknown>[] = [{
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content
      }];
      return output;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const items: Record<string, unknown>[] = [
        ...(message.content
          ? [{ role: "assistant", content: message.content }]
          : []),
        ...message.toolCalls.map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments
        }))
      ];
      return items;
    }
    const item: Record<string, unknown>[] = [{ role: message.role, content: message.content }];
    return item;
  });
}

function endpoint(provider: ProviderConfig, path: string): string {
  return `${provider.baseUrl.replace(/\/+$/, "")}/${path}`;
}

function requestHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...provider.headers
  };
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : provider.apiKey;
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

async function* sse(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const queue = new AsyncQueue<string>();
  const parser = createSseParser((data) => queue.push(data));
  void (async () => {
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) {
          parser(decoder.decode(), true);
          queue.end();
          break;
        }
        parser(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      queue.fail(error);
    }
  })();
  try {
    for await (const data of queue) yield data;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown = null;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: unknown): void {
    this.failure = error;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.failure) return Promise.reject(this.failure);
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.done) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      }
    };
  }
}

export function supportedEfforts(): readonly string[] {
  return REASONING_EFFORTS;
}
