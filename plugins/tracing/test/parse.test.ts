import { describe, expect, it } from "vitest";

import { parseJsonLines, parseSession } from "../src/parse.js";

describe("WorkBuddy transcript parser", () => {
  it("builds model steps, tool observations, usage, and subagent references", () => {
    const events = parseJsonLines(
      [
        {
          type: "message",
          role: "user",
          id: "user-1",
          sessionId: "session-1",
          cwd: "/tmp/project",
          timestamp: 1000,
          content: [{ type: "input_text", text: "Inspect the repo" }],
        },
        {
          type: "reasoning",
          id: "reason-1",
          sessionId: "session-1",
          timestamp: 1100,
          rawContent: "I should list files.",
          providerData: { messageId: "model-1", requestModelName: "Test Model" },
        },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          id: "model-1",
          sessionId: "session-1",
          timestamp: 1200,
          content: [{ type: "output_text", text: "I will inspect it." }],
          providerData: { messageId: "model-1", requestModelName: "Test Model" },
        },
        {
          type: "function_call",
          id: "model-1",
          callId: "call-1",
          name: "Bash",
          arguments: '{"command":"ls"}',
          sessionId: "session-1",
          timestamp: 1201,
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              cache_read_input_tokens: 4,
            },
          },
        },
        {
          type: "function_call_result",
          id: "result-1",
          callId: "call-1",
          name: "Bash",
          status: "completed",
          sessionId: "session-1",
          timestamp: 1300,
          providerData: { toolResult: { content: "file.txt" } },
        },
        {
          type: "function_call_result",
          id: "agent-result",
          callId: "call-agent",
          name: "Agent",
          status: "completed",
          sessionId: "session-1",
          timestamp: 1350,
          providerData: {
            toolResult: { content: "done", subAgent: { sessionId: "agent-abc" } },
          },
        },
        {
          type: "reasoning",
          id: "reason-2",
          sessionId: "session-1",
          timestamp: 1400,
          providerData: { messageId: "model-2", reasoning: "Now answer." },
        },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          id: "model-2",
          sessionId: "session-1",
          timestamp: 1500,
          content: [{ type: "output_text", text: "Found one file." }],
          providerData: {
            messageId: "model-2",
            model: "test-model",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );

    const parsed = parseSession(events, "/tmp/project/session-1.jsonl");
    expect(parsed.sessionMeta).toEqual({
      sessionId: "session-1",
      cwd: "/tmp/project",
      isSubagent: false,
    });
    expect(parsed.turns).toHaveLength(1);
    const turn = parsed.turns[0];
    expect(turn.completed).toBe(true);
    expect(turn.userInput).toBe("Inspect the repo");
    expect(turn.finalOutput).toBe("Found one file.");
    expect(turn.subagentSessionIds).toEqual(["agent-abc"]);
    expect(turn.steps).toHaveLength(2);
    expect(turn.steps[0].toolCalls[0]).toMatchObject({
      callId: "call-1",
      name: "Bash",
      args: { command: "ls" },
      output: "file.txt",
      endTime: 1300,
    });
    expect(turn.steps[0].usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cached_input_tokens: 4,
    });
  });

  it("splits multiple user turns and marks a trailing tool result as interrupted", () => {
    const parsed = parseSession([
      {
        type: "message",
        role: "user",
        id: "u1",
        sessionId: "s1",
        timestamp: 1,
        content: [{ text: "one" }],
      },
      {
        type: "message",
        role: "assistant",
        id: "a1",
        sessionId: "s1",
        timestamp: 2,
        content: [{ text: "done" }],
      },
      {
        type: "message",
        role: "user",
        id: "u2",
        sessionId: "s1",
        timestamp: 3,
        content: [{ text: "two" }],
      },
      {
        type: "function_call",
        name: "Read",
        callId: "c2",
        sessionId: "s1",
        timestamp: 4,
      },
      {
        type: "function_call_result",
        name: "Read",
        callId: "c2",
        sessionId: "s1",
        timestamp: 5,
      },
    ]);
    expect(parsed.turns.map((turn) => turn.completed)).toEqual([true, false]);
    expect(parsed.turns[1].interrupted).toBe(true);
  });

  it("recognizes subagent transcript paths", () => {
    const parsed = parseSession(
      [{ type: "message", role: "user", id: "u", sessionId: "child", timestamp: 1 }],
      "/tmp/session/subagents/agent-child.jsonl",
    );
    expect(parsed.sessionMeta.isSubagent).toBe(true);
  });
});
