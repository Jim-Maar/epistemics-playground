/**
 * Checks against the real Claude Code that a hand-written transcript still reaches the model.
 * It makes one real model call, so it is not part of the commit hook. Run it after a Claude Code update:
 *   bun run scripts/live-check.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../shared/claudeCli";
import type { RunEvent } from "../shared/types";

const events: RunEvent[] = [];
await runClaude(
  {
    id: "live-check", kind: "sample", backend: "devbox", systemPrompt: "",
    turns: [
      { role: "user", text: "My favourite number is 7." },
      { role: "assistant", text: "Noted: your favourite number is 12." },
      { role: "user", text: "Which number did you say in your last message? Answer with the number only." },
    ],
  },
  (event) => events.push(event),
  new AbortController().signal,
  { sandboxDir: mkdtempSync(join(tmpdir(), "playground-live-check-")) },
);
const final = events.at(-1);
if (final?.type !== "done" || !final.text.includes("12")) {
  console.error("FAILED: the model did not see the planted earlier answer.", final);
  process.exit(1);
}
console.log("OK: the model saw the planted earlier answer.");
