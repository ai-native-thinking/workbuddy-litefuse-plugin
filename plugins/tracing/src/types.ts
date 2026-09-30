export type HookInput = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
};

export type WorkBuddyEvent = {
  type?: string;
  id?: string;
  parentId?: string;
  sessionId?: string;
  timestamp?: number | string;
  cwd?: string;
  role?: string;
  status?: string;
  content?: unknown;
  rawContent?: unknown;
  name?: string;
  arguments?: unknown;
  output?: unknown;
  callId?: string;
  message?: Record<string, unknown>;
  providerData?: Record<string, unknown>;
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
};

export type ToolCall = {
  callId: string;
  name: string;
  args: unknown;
  output?: unknown;
  error?: string;
  startTime: number;
  endTime?: number;
};

export type ModelStep = {
  id: string;
  model?: string;
  text?: string;
  reasoning?: string;
  usage?: TokenUsage;
  toolCalls: ToolCall[];
  startTime: number;
  endTime: number;
};

export type Turn = {
  turnId: string;
  userInput?: string;
  finalOutput?: string;
  model?: string;
  steps: ModelStep[];
  subagentSessionIds: string[];
  startTime: number;
  endTime: number;
  completed: boolean;
  interrupted: boolean;
};

export type SessionMeta = {
  sessionId: string;
  cwd?: string;
  isSubagent: boolean;
};

export type ParsedSession = {
  sessionMeta: SessionMeta;
  turns: Turn[];
};
