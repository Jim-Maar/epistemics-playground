# Epistemics Playground

A password-gated chat workbench for probing how Claude Opus 5.5 handles evidence, uncertainty and pressure.

- Web app: https://jim-maar.github.io/epistemics-playground/
- Plan with UI mock-ups: https://claude.ai/artifact/8zUSWKxubL2PSvrp6ZF1xJ

## How the pieces fit

| Folder | What it is |
| --- | --- |
| `web/` | The app (Vite, React). GitHub Actions publishes it to GitHub Pages on every push to main. |
| `server/` | The API server (Bun). It runs on the devbox as the systemd user service `epistemics-playground`, behind Caddy at `https://159-195-131-30.sslip.io/playground/`. It checks the password, runs the model calls and saves every browser's data. |
| `shared/` | Types and the Claude Code runner, used by the server and the connector. |
| `connector/` | A small program a friend runs to use their own Claude Code for model calls. The build puts it at `connect.mjs` next to the app. |
| `migrations/` | The database schema. `bun run migrate` applies new files. |

Data lives in two places. Each browser keeps its own threads in IndexedDB, and the API server copies every change to Supabase Postgres (organization "Epistemics Eval Project", project `epistemics-playground`).

## Where model calls run

Each browser picks one of three options in Settings.

1. **Devbox Claude Code** (default): a headless `claude -p` on the devbox, with Opus 5.5 at effort high and no tools, memory, CLAUDE.md, MCP servers, skills or hooks.
2. **My own Claude Code**: the same call, on the computer of whoever runs `connect.mjs`.
3. **Anthropic API**: the Messages API with `ANTHROPIC_API_KEY` from the env file. Off while the key is missing.

## Env file

`~/dev/env/epistemics-playground/env`, linked as `.env` into each checkout.

| Variable | Purpose |
| --- | --- |
| `PLAYGROUND_PASSWORD_HASH_B64` | The app password. Make a new one with `bun run scripts/hash-password.ts <password>`. |
| `DATABASE_URL` | The Supabase Postgres connection string (session pooler). |
| `ANTHROPIC_API_KEY` | Optional. Turns on the Anthropic API option. |

## Working on it

```bash
bun install                 # also turns on the pre-commit hook (type check and tests)
bun run server              # API server on port 8095
bun run dev                 # web app on http://localhost:5173, talks to the local server
bun run scripts/live-check.ts   # one real model call: does a planted earlier answer still reach the model?
```

A push to main deploys both halves. GitHub Actions rebuilds the web app. On the devbox, `pull-main-checkouts` pulls the main checkout and runs `scripts/after-pull`, which applies migrations and restarts the service. The first setup on a new machine is `scripts/install-service`.
