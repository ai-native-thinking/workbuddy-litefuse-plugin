import type {
  ModelStep,
  ParsedSession,
  TokenUsage,
  ToolCall,
  Turn,
  WorkBuddyEvent,
} from "./types.js";

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function eventTime(event: WorkBuddyEvent, fallback = Date.now()): number {
  if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp)) {
    return event.timestamp;
  }
  if (typeof event.timestamp === "string") {
    const parsed = Date.parse(event.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === "string") return item;
        const block = objectValue(item);
        if (!block) return "";
        for (const key of ["text", "content", "value"]) {
          if (typeof block[key] === "string") return block[key] as string;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  const object = objectValue(value);
  if (!object) return undefined;
  for (const key of ["text", "content", "value"]) {
    if (typeof object[key] === "string") return object[key] as string;
  }
  return undefined;
}

function usageFrom(value: unknown): TokenUsage | undefined {
  const usage = objectValue(value);
  if (!usage) return undefined;
  const input = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens);
  const output = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens);
  const total = numberValue(usage.total_tokens) ?? numberValue(usage.totalTokens);
  if (input === undefined || output === undefined || total === undefined) return undefined;

  const inputDetails = Array.isArray(usage.inputTokensDetails)
    ? objectValue(usage.inputTokensDetails[0])
    : objectValue(usage.prompt_tokens_details);
  const outputDetails = Array.isArray(usage.outputTokensDetails)
    ? objectValue(usage.outputTokensDetails[0])
    : objectValue(usage.completion_tokens_details);

  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cached_input_tokens:
      numberValue(usage.cache_read_input_tokens) ??
      numberValue(usage.prompt_cache_hit_tokens) ??
      numberValue(inputDetails?.cached_tokens),
    reasoning_output_tokens:
      numberValue(usage.completion_thinking_tokens) ?? numberValue(outputDetails?.reasoning_tokens),
  };
}

export function extractUsage(event: WorkBuddyEvent): TokenUsage | undefined {
  const provider = objectValue(event.providerData);
  return (
    usageFrom(objectValue(event.message)?.usage) ??
    usageFrom(provider?.usage) ??
    usageFrom(provider?.rawUsage)
  );
}

function providerString(event: WorkBuddyEvent, ...keys: string[]): string | undefined {
  const provider = objectValue(event.providerData);
  for (const key of keys) {
    if (typeof provider?.[key] === "string") return provider[key] as string;
  }
  return undefined;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function resultOutput(event: WorkBuddyEvent): unknown {
  if (event.output !== undefined) return event.output;
  const toolResult = objectValue(objectValue(event.providerData)?.toolResult);
  return toolResult?.content ?? toolResult;
}

function resultError(event: WorkBuddyEvent): string | undefined {
  if (event.status && event.status !== "completed") return `Tool status: ${event.status}`;
  const toolResult = objectValue(objectValue(event.providerData)?.toolResult);
  const raw = objectValue(toolResult?.rawResponse);
  const exitCode = numberValue(raw?.exitCode);
  if (exitCode !== undefined && exitCode !== 0) {
    const stderr = typeof raw?.stderr === "string" ? raw.stderr : undefined;
    return stderr || `Tool exited with code ${exitCode}`;
  }
  if (raw?.interrupted === true) return "Tool execution interrupted";
  if (raw?.sandboxDenied === true) return "Tool execution denied by sandbox";
  return undefined;
}

function subagentId(event: WorkBuddyEvent): string | undefined {
  const toolResult = objectValue(objectValue(event.providerData)?.toolResult);
  const subAgent = objectValue(toolResult?.subAgent);
  return typeof subAgent?.sessionId === "string" ? subAgent.sessionId : undefined;
}

function finalizeTurn(events: WorkBuddyEvent[]): Turn | undefined {
  const user = events.find((event) => event.type === "message" && event.role === "user");
  if (!user) return undefined;

  const toolCalls = new Map<string, ToolCall>();
  const steps: ModelStep[] = [];
  let current: ModelStep | undefined;
  let model: string | undefined;
  let finalOutput: string | undefined;
  const subagentSessionIds = new Set<string>();

  const flush = () => {
    if (!current) return;
    current.endTime = Math.max(current.endTime, current.startTime);
    steps.push(current);
    current = undefined;
  };

  const ensureStep = (event: WorkBuddyEvent): ModelStep => {
    if (current) return current;
    const time = eventTime(event, eventTime(user));
    current = {
      id: providerString(event, "messageId") ?? event.id ?? `step-${steps.length + 1}`,
      model: providerString(event, "requestModelName", "model"),
      toolCalls: [],
      startTime: time,
      endTime: time,
    };
    return current;
  };

  for (const event of events) {
    const time = eventTime(event, eventTime(user));
    if (event.type === "reasoning") {
      flush();
      const step = ensureStep(event);
      step.reasoning =
        extractText(event.rawContent) ??
        extractText(event.content) ??
        providerString(event, "reasoning");
      continue;
    }

    if (event.type === "message" && event.role === "assistant") {
      const step = ensureStep(event);
      const text = extractText(event.content);
      if (text) {
        step.text = step.text ? `${step.text}\n${text}` : text;
        finalOutput = text;
      }
      step.model ??= providerString(event, "requestModelName", "model");
      step.usage = extractUsage(event) ?? step.usage;
      step.endTime = Math.max(step.endTime, time);
      model = step.model ?? model;
      continue;
    }

    if (event.type === "function_call") {
      const step = ensureStep(event);
      const callId = event.callId ?? `${event.id ?? step.id}:${step.toolCalls.length}`;
      const tool: ToolCall = {
        callId,
        name: event.name ?? "tool",
        args: parseArguments(event.arguments),
        startTime: time,
      };
      toolCalls.set(callId, tool);
      step.toolCalls.push(tool);
      step.reasoning ??= providerString(event, "reasoning");
      step.model ??= providerString(event, "requestModelName", "model");
      step.usage = extractUsage(event) ?? step.usage;
      step.endTime = Math.max(step.endTime, time);
      model = step.model ?? model;
      continue;
    }

    if (event.type === "function_call_result") {
      const tool = event.callId ? toolCalls.get(event.callId) : undefined;
      if (tool) {
        tool.output = resultOutput(event);
        tool.error = resultError(event);
        tool.endTime = time;
      }
      const agentId = subagentId(event);
      if (agentId) subagentSessionIds.add(agentId);
      if (current) current.endTime = Math.max(current.endTime, time);
    }
  }
  flush();

  const meaningful = events.filter((event) =>
    ["message", "reasoning", "function_call", "function_call_result"].includes(event.type ?? ""),
  );
  const last = meaningful.at(-1);
  const completed = last?.type === "message" && last.role === "assistant" && !!finalOutput;
  const interrupted = !completed && !!last;
  const startTime = eventTime(user);
  const endTime = eventTime(last ?? user, startTime);
  const sessionId =
    user.sessionId ?? events.find((event) => event.sessionId)?.sessionId ?? "unknown";

  return {
    turnId: user.id ?? `${sessionId}:${startTime}`,
    userInput: extractText(user.content),
    finalOutput,
    model,
    steps,
    subagentSessionIds: [...subagentSessionIds],
    startTime,
    endTime,
    completed,
    interrupted,
  };
}

export function parseSession(events: WorkBuddyEvent[], sourcePath = ""): ParsedSession {
  const sessionId = events.find((event) => event.sessionId)?.sessionId ?? "unknown";
  const cwd = events.find((event) => event.cwd)?.cwd;
  const isSubagent =
    sourcePath.includes("/subagents/") ||
    events.some((event) => objectValue(event.providerData)?.isSubAgent === true);
  const groups: WorkBuddyEvent[][] = [];
  let current: WorkBuddyEvent[] | undefined;
  for (const event of events) {
    if (event.type === "message" && event.role === "user") {
      if (current?.length) groups.push(current);
      current = [event];
    } else if (current) {
      current.push(event);
    }
  }
  if (current?.length) groups.push(current);

  return {
    sessionMeta: { sessionId, cwd, isSubagent },
    turns: groups
      .map((group) => finalizeTurn(group))
      .filter((turn): turn is Turn => turn !== undefined),
  };
}

export function parseJsonLines(data: string): WorkBuddyEvent[] {
  const events: WorkBuddyEvent[] = [];
  for (const raw of data.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as WorkBuddyEvent);
      }
    } catch {
      // Ignore a partial trailing line written while Stop is firing.
    }
  }
  return events;
}
