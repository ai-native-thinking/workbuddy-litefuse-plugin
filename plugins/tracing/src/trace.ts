import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createTraceId,
  propagateAttributes,
  startObservation,
  type LangfuseGenerationAttributes,
  type LangfuseObservation,
} from "@langfuse/tracing";
import { TraceFlags, type SpanContext } from "@opentelemetry/api";

import type { Config } from "./config.js";
import { parseJsonLines, parseSession } from "./parse.js";
import { loadUploadedTurnIds, markTurnUploaded } from "./sidecar.js";
import type { ModelStep, SessionMeta, TokenUsage, ToolCall, Turn } from "./types.js";
import { debugLog, toText, truncate } from "./utils.js";

const SEED_PARENT_SPAN_ID = "0123456789abcdef";

async function readSession(file: string) {
  return parseJsonLines(await fs.readFile(file, "utf8"));
}

async function seededTraceParent(
  config: Config,
  session: SessionMeta,
  turnNumber: number,
): Promise<SpanContext | undefined> {
  if (!config.trace_seed) return undefined;
  const seed = session.isSubagent
    ? `${config.trace_seed}:${session.sessionId}:${turnNumber}`
    : `${config.trace_seed}:${turnNumber}`;
  try {
    return {
      traceId: await createTraceId(seed),
      spanId: SEED_PARENT_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
  } catch (error) {
    debugLog("failed to derive deterministic trace id", error);
    if (config.fail_on_error) throw error;
    return undefined;
  }
}

function validCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function toUsageDetails(
  usage: TokenUsage | undefined,
): LangfuseGenerationAttributes["usageDetails"] {
  if (!usage) return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const total = usage.total_tokens;
  if (!validCount(input) || !validCount(output) || !validCount(total) || total !== input + output) {
    debugLog("dropping invalid token usage", usage);
    return undefined;
  }
  const cached = usage.cached_input_tokens;
  const reasoning = usage.reasoning_output_tokens;
  if (
    (cached !== undefined && (!validCount(cached) || cached > input)) ||
    (reasoning !== undefined && (!validCount(reasoning) || reasoning > output))
  ) {
    debugLog("dropping implausible token details", usage);
    return undefined;
  }
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(reasoning !== undefined
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
  } as unknown as LangfuseGenerationAttributes["usageDetails"];
}

type Clip = (value: unknown) => unknown;
const makeClip =
  (maxChars: number): Clip =>
  (value) =>
    typeof value === "string" ? truncate(value, maxChars) : value;

function generationOutput(step: ModelStep, clip: Clip): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  if (step.text) output.content = clip(step.text);
  if (step.reasoning) output.reasoning = clip(step.reasoning);
  if (step.toolCalls.length) {
    output.tool_calls = step.toolCalls.map((tool) => ({
      id: tool.callId,
      name: tool.name,
      arguments: tool.args,
    }));
  }
  return Object.keys(output).length ? output : undefined;
}

function emitToolCall(
  call: ToolCall,
  parent: LangfuseObservation,
  clip: Clip,
  fallbackEnd: number,
): void {
  const observation = startObservation(
    call.name || "tool",
    {
      input: call.args,
      output: call.output !== undefined ? clip(toText(call.output)) : undefined,
      level: call.error ? "ERROR" : undefined,
      statusMessage: call.error ? (clip(call.error) as string) : undefined,
      metadata: {
        "workbuddy.call_id": call.callId,
        "workbuddy.tool_name": call.name || "tool",
      },
    },
    {
      asType: "tool",
      startTime: new Date(call.startTime),
      parentSpanContext: parent.otelSpan.spanContext(),
    },
  );
  observation.end(new Date(call.endTime ?? fallbackEnd));
}

async function findSubagentTranscript(parentFile: string, sessionId: string) {
  const fileName = sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`;
  const candidates = [
    path.join(path.dirname(parentFile), "subagents", fileName),
    path.join(path.dirname(path.dirname(parentFile)), "subagents", fileName),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known WorkBuddy subagent layout.
    }
  }
  return undefined;
}

async function emitTurn(
  turn: Turn,
  session: SessionMeta,
  context: {
    config: Config;
    transcript: string;
    parent?: LangfuseObservation;
    seededParent?: SpanContext;
  },
): Promise<void> {
  const clip = makeClip(context.config.max_chars);
  const isSubagent = session.isSubagent || !!context.parent;
  const root = startObservation(
    isSubagent ? "WorkBuddy Subagent Turn" : "WorkBuddy Turn",
    {
      input: turn.userInput ? clip(turn.userInput) : undefined,
      output: turn.finalOutput ? clip(turn.finalOutput) : undefined,
      level: turn.interrupted ? "WARNING" : undefined,
      statusMessage: turn.interrupted
        ? "Turn did not finish with an assistant response"
        : undefined,
      metadata: {
        "workbuddy.turn_id": turn.turnId,
        "workbuddy.session_id": session.sessionId,
        "workbuddy.cwd": session.cwd,
        "workbuddy.model": turn.model,
        "workbuddy.is_subagent": isSubagent,
        "workbuddy.tool_call_count": turn.steps.reduce(
          (count, step) => count + step.toolCalls.length,
          0,
        ),
        "litefuse.ingestion": "otel",
      },
    },
    {
      asType: "agent",
      startTime: new Date(turn.startTime),
      parentSpanContext: context.parent?.otelSpan.spanContext() ?? context.seededParent,
    },
  );

  let previousToolResults: unknown;
  for (let index = 0; index < turn.steps.length; index++) {
    const step = turn.steps[index];
    const generation = startObservation(
      isSubagent ? "LLM Subagent" : "LLM",
      {
        input: index === 0 ? clip(turn.userInput) : previousToolResults,
        output: generationOutput(step, clip),
        model: step.model ?? turn.model,
        usageDetails: toUsageDetails(step.usage),
        metadata: { "workbuddy.step_index": index },
      },
      {
        asType: "generation",
        startTime: new Date(step.startTime),
        parentSpanContext: root.otelSpan.spanContext(),
      },
    );
    for (const call of step.toolCalls) emitToolCall(call, generation, clip, step.endTime);
    generation.end(new Date(step.endTime));
    previousToolResults = step.toolCalls.length
      ? step.toolCalls.map((call) => ({
          name: call.name,
          output: call.output !== undefined ? clip(toText(call.output)) : undefined,
          ...(call.error ? { error: clip(call.error) } : {}),
        }))
      : undefined;
  }

  for (const subagentSessionId of turn.subagentSessionIds) {
    const child = await findSubagentTranscript(context.transcript, subagentSessionId);
    if (!child) {
      debugLog(`subagent transcript not found: ${subagentSessionId}`);
      continue;
    }
    await convertTranscript(child, { config: context.config, parent: root });
  }
  root.end(new Date(turn.endTime));
}

export async function convertTranscript(
  transcript: string,
  options: { config: Config; parent?: LangfuseObservation },
): Promise<void> {
  const { sessionMeta, turns } = parseSession(await readSession(transcript), transcript);
  debugLog(`parsed ${turns.length} turn(s) from ${path.basename(transcript)}`);

  if (options.parent) {
    for (const turn of turns) {
      await emitTurn(turn, sessionMeta, {
        config: options.config,
        transcript,
        parent: options.parent,
      });
    }
    return;
  }

  const uploaded = await loadUploadedTurnIds(transcript);
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    if (turn.completed && uploaded.has(turn.turnId)) continue;
    const seededParent = await seededTraceParent(options.config, sessionMeta, index + 1);
    await propagateAttributes(
      {
        sessionId: sessionMeta.sessionId,
        traceName: "WorkBuddy Turn",
        ...(options.config.user_id ? { userId: options.config.user_id } : {}),
        ...(options.config.environment ? { environment: options.config.environment } : {}),
        ...(options.config.version ? { version: options.config.version } : {}),
        ...(options.config.tags ? { tags: options.config.tags } : {}),
        ...(options.config.metadata ? { metadata: options.config.metadata } : {}),
      },
      async () => {
        await emitTurn(turn, sessionMeta, {
          config: options.config,
          transcript,
          seededParent,
        });
      },
    );
    if (turn.completed) await markTurnUploaded(transcript, turn.turnId);
  }
}
