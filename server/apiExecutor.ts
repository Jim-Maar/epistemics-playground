/** API mode: runs a model call with the Anthropic API key from the env file. */
import Anthropic from "@anthropic-ai/sdk";
import { mergeConsecutiveTurns } from "../shared/claudeCli";
import { SCORE_SCHEMA, parseJudgement, type RunEvent, type RunRequest } from "../shared/types";
import { config } from "./config";

const MODEL = "claude-opus-5-5";
const MAX_OUTPUT_TOKENS = 64000;

let client: Anthropic | null = null;

function apiClient(): Anthropic {
  if (!config.anthropicApiKey) throw new Error("API mode is off. Put ANTHROPIC_API_KEY in the env file.");
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

function buildParams(request: RunRequest): Anthropic.MessageStreamParams {
  // Server-side refusal fallbacks are left off on purpose. A fallback would answer with a
  // different model, and every answer in this tool must come from Opus 5.5.
  const base = {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: "adaptive" as const, display: "summarized" as const },
  };
  if (request.kind === "judge") {
    return {
      ...base,
      output_config: { effort: "high", format: { type: "json_schema", schema: SCORE_SCHEMA } },
      messages: [{ role: "user", content: request.prompt }],
    } as Anthropic.MessageStreamParams;
  }
  const turns = mergeConsecutiveTurns(request.turns);
  if (turns.at(-1)?.role !== "user") throw new Error("An answer needs a user message right before it.");
  return {
    ...base,
    output_config: { effort: "high" },
    ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
    messages: turns.map((t) => ({ role: t.role, content: t.text })),
  } as Anthropic.MessageStreamParams;
}

export async function runApi(request: RunRequest, emit: (event: RunEvent) => void, signal: AbortSignal) {
  let text = "";
  let thinking = "";
  try {
    const stream = apiClient().messages.stream(buildParams(request), { signal });
    emit({ type: "started", model: MODEL });
    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") {
        text += event.delta.text;
        if (request.kind === "sample") emit({ type: "text", text: event.delta.text });
      } else if (event.delta.type === "thinking_delta") {
        thinking += event.delta.thinking;
        emit({ type: "thinking", text: event.delta.thinking });
      }
    }
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      emit({ type: "error", message: "The model refused this request." });
      return;
    }
    if (request.kind === "judge") {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const judgement = parseJudgement(parsed);
      emit(
        judgement
          ? { type: "done", text: "", thinking, model: message.model, judgement }
          : { type: "error", message: "The judge did not return a score from 0 to 1." },
      );
      return;
    }
    emit({ type: "done", text, thinking, model: message.model });
  } catch (err) {
    if (signal.aborted) {
      emit({ type: "done", text, thinking, model: MODEL });
      return;
    }
    const message = err instanceof Anthropic.APIError ? `API error ${err.status}: ${err.message}` : (err as Error).message;
    emit({ type: "error", message });
  }
}
