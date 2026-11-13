/** Turns the raw score records of one judge on one message into what a chip shows. */
import { usableText } from "./context";
import type { AttachmentRec, JudgeRec, MessageRec, SampleRec, ScoreRec } from "./db";

const LOW_SCORE = 0.34;
const HIGH_SCORE = 0.67;

export type TargetScore = { targetId: string; label: string; score?: ScoreRec; outOfDate: boolean };

export type ScoreSummary = {
  average: number | null;
  doneCount: number;
  targetCount: number;
  pending: boolean;
  outOfDate: boolean;
  failed: boolean;
  targets: TargetScore[];
};

function newestScore(scores: ScoreRec[]): ScoreRec | undefined {
  return scores.reduce<ScoreRec | undefined>((best, s) => (!best || s.createdAt > best.createdAt ? s : best), undefined);
}

export function summarize(
  attachment: AttachmentRec, judge: JudgeRec, message: MessageRec, samples: SampleRec[], scores: ScoreRec[],
): ScoreSummary {
  const mine = scores.filter((s) => s.attachmentId === attachment.id);
  const targetIds =
    message.role === "user"
      ? [{ targetId: message.id, label: "Message" }]
      : samples.filter((s) => usableText(s)).map((s) => ({ targetId: s.id, label: String(s.index + 1) }));
  const targets = targetIds.map(({ targetId, label }) => {
    const forTarget = mine.filter((s) => s.targetId === targetId);
    const current = newestScore(forTarget.filter((s) => s.judgeRevision === judge.revision));
    const score = current ?? newestScore(forTarget.filter((s) => s.status === "done"));
    return { targetId, label, score, outOfDate: !current && Boolean(score) };
  });
  const values = targets.map((t) => t.score).filter((s): s is ScoreRec => s?.status === "done" && s.value !== undefined);
  return {
    average: values.length ? values.reduce((sum, s) => sum + s.value!, 0) / values.length : null,
    doneCount: values.length,
    targetCount: targets.length,
    pending: targets.some((t) => t.score?.status === "queued" || t.score?.status === "running"),
    outOfDate: targets.some((t) => t.outOfDate),
    failed: targets.some((t) => t.score?.status === "error"),
    targets,
  };
}

/** The CSS color for a score. Green always means good, also for "lower is better" judges. */
export function scoreColor(value: number, lowerIsBetter: boolean): string {
  const goodness = lowerIsBetter ? 1 - value : value;
  if (goodness < LOW_SCORE) return "var(--bad)";
  if (goodness < HIGH_SCORE) return "var(--mid)";
  return "var(--good)";
}

export const formatScore = (value: number) => value.toFixed(2);
