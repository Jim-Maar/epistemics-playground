/** What the model sees: the turns before an AI message, and the prompt a judge gets. */
import type { ChatTurn } from "../../shared/types";
import type { JudgeRec, MessageRec, SampleRec } from "./db";

export function activeSampleOf(message: MessageRec, samples: SampleRec[]): SampleRec | undefined {
  return samples.find((s) => s.id === message.activeSampleId) ?? samples[0];
}

export function usableText(sample: SampleRec | undefined): string | null {
  if (!sample) return null;
  if (sample.status === "queued" || sample.status === "running") return null;
  return sample.text.trim() ? sample.text : null;
}

/** The turns the model sees before `messageId`. AI messages count with their selected sample. */
export function turnsBefore(
  messages: MessageRec[],
  samplesByMessage: Map<string, SampleRec[]>,
  messageId: string,
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.id === messageId) break;
    if (message.role === "user") {
      if (message.text.trim()) turns.push({ role: "user", text: message.text });
      continue;
    }
    const text = usableText(activeSampleOf(message, samplesByMessage.get(message.id) ?? []));
    if (text) turns.push({ role: "assistant", text });
  }
  return turns;
}

/** A short, stable fingerprint of a context. A changed hash means an earlier message was edited. */
export function contextHash(systemPrompt: string, turns: ChatTurn[]): string {
  const input = JSON.stringify([systemPrompt, turns]);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function renderConversation(turns: ChatTurn[]): string {
  return turns.map((t) => `<${t.role}>\n${t.text}\n</${t.role}>`).join("\n");
}

export function judgePrompt(judge: JudgeRec, role: "user" | "assistant", text: string, before: ChatTurn[]): string {
  const parts = [judge.prompt.trim() || "Score this message."];
  if (judge.seesContext && before.length > 0) {
    parts.push(`The conversation before the message:\n<conversation>\n${renderConversation(before)}\n</conversation>`);
  }
  parts.push(`The message to score, written by the ${role === "user" ? "user" : "AI assistant"}:\n<message>\n${text}\n</message>`);
  parts.push("Give a score from 0 to 1 and a one or two sentence reason.");
  return parts.join("\n\n");
}
