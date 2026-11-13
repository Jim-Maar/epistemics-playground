import { describe, expect, test } from "bun:test";
import { mergeConsecutiveTurns, parseRateLimitEvent } from "../shared/claudeCli";
import { parseJudgement } from "../shared/types";
import { contextHash, judgePrompt, turnsBefore } from "../web/src/context";
import type { AttachmentRec, JudgeRec, MessageRec, SampleRec, ScoreRec } from "../web/src/db";
import { scoreColor, summarize } from "../web/src/scores";

const base = { createdAt: 1, updatedAt: 1 };
const user = (id: string, text: string): MessageRec => ({ ...base, id, threadId: "t", order: id, role: "user", text });
const assistant = (id: string, activeSampleId: string): MessageRec => ({ ...base, id, threadId: "t", order: id, role: "assistant", text: "", activeSampleId });
const sample = (id: string, messageId: string, index: number, text: string, status: SampleRec["status"] = "done"): SampleRec => ({
  ...base, id, messageId, threadId: "t", index, text, status,
});
const judge: JudgeRec = { ...base, id: "j", name: "Judge", prompt: "Score it.", seesContext: false, lowerIsBetter: false, revision: 2, order: "a0" };

describe("turnsBefore", () => {
  const messages = [user("m1", "Question"), assistant("m2", "s2"), user("m3", "Follow-up"), assistant("m4", "s4")];
  const samples = new Map([["m2", [sample("s1", "m2", 0, "First"), sample("s2", "m2", 1, "Second")]]]);

  test("uses the selected sample of earlier AI messages", () => {
    expect(turnsBefore(messages, samples, "m4")).toEqual([
      { role: "user", text: "Question" },
      { role: "assistant", text: "Second" },
      { role: "user", text: "Follow-up" },
    ]);
  });

  test("leaves out an AI message whose selected sample is still running", () => {
    const running = new Map([["m2", [sample("s2", "m2", 0, "partial", "running")]]]);
    expect(turnsBefore(messages, running, "m4").map((t) => t.role)).toEqual(["user", "user"]);
  });

  test("the hash changes when an earlier message changes", () => {
    const before = contextHash("", turnsBefore(messages, samples, "m4"));
    const edited = [user("m1", "Another question"), ...messages.slice(1)];
    expect(contextHash("", turnsBefore(edited, samples, "m4"))).not.toBe(before);
    expect(contextHash("system", turnsBefore(messages, samples, "m4"))).not.toBe(before);
  });
});

describe("judgePrompt", () => {
  test("shows the conversation only when the judge asks for it", () => {
    const before = [{ role: "user" as const, text: "Earlier question" }];
    expect(judgePrompt(judge, "assistant", "Answer", before)).not.toContain("Earlier question");
    expect(judgePrompt({ ...judge, seesContext: true }, "assistant", "Answer", before)).toContain("Earlier question");
  });
});

describe("summarize", () => {
  const message = assistant("m2", "s1");
  const attachment: AttachmentRec = { ...base, id: "a", judgeId: "j", messageId: "m2", threadId: "t" };
  const samples = [sample("s1", "m2", 0, "One"), sample("s2", "m2", 1, "Two"), sample("s3", "m2", 2, "", "running")];
  const score = (id: string, targetId: string, value: number, judgeRevision = 2): ScoreRec => ({
    ...base, id, attachmentId: "a", judgeId: "j", threadId: "t", targetId, value, status: "done", judgeRevision,
  });

  test("averages the scores of the finished samples", () => {
    const summary = summarize(attachment, judge, message, samples, [score("x", "s1", 0.2), score("y", "s2", 0.6)]);
    expect(summary.average).toBeCloseTo(0.4);
    expect(summary.targetCount).toBe(2);
    expect(summary.outOfDate).toBe(false);
  });

  test("marks scores from an older judge revision as out of date", () => {
    const summary = summarize(attachment, judge, message, samples, [score("x", "s1", 0.2, 1)]);
    expect(summary.outOfDate).toBe(true);
    expect(summary.average).toBeCloseTo(0.2);
  });

  test("green means good, also when lower is better", () => {
    expect(scoreColor(0.9, false)).toBe("var(--good)");
    expect(scoreColor(0.9, true)).toBe("var(--bad)");
  });
});

describe("runner helpers", () => {
  test("merges turns of the same role, because the API needs alternating roles", () => {
    expect(mergeConsecutiveTurns([{ role: "user", text: "a" }, { role: "user", text: "b" }, { role: "assistant", text: "c" }])).toEqual([
      { role: "user", text: "a\n\nb" },
      { role: "assistant", text: "c" },
    ]);
  });

  test("reads the usage windows of a rate limit event", () => {
    const usage = parseRateLimitEvent({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.72, resetsAt: 1794740400 } } });
    expect(usage.windows).toEqual([{ name: "seven_day", utilization: 0.72, resetsAt: 1794740400000 }]);
  });

  test("rejects scores outside 0 to 1", () => {
    expect(parseJudgement({ score: 1.2, reason: "x" })).toBeNull();
    expect(parseJudgement({ score: 0.5, reason: "x" })).toEqual({ score: 0.5, reason: "x" });
  });
});
