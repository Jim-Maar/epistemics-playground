# Epistemics Playground

A password-gated chat workbench for probing how Claude Opus 5.5 handles evidence, uncertainty and pressure.

- Web app: http://localhost:5173/ on Jim's Mac. The public site on GitHub Pages is switched off since 2026-11-13.
- Plan with UI mock-ups: https://claude.ai/artifact/8zUSWKxubL2PSvrp6ZF1xJ

## How the pieces fit

| Folder | What it is |
| --- | --- |
| `web/` | The app (Vite, React). Vite's dev server serves it on port 5173 of the devbox and passes `/api/...` on to the API server. |
| `server/` | The API server (Bun). It runs on the devbox as the systemd user service `epistemics-playground` on port 8095. It checks the password, runs the model calls and saves every browser's data. |
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

## Running it

The app runs only on localhost for now. Start it from the main checkout with `mac-tunnel serve 5173 bun run dev` and open http://localhost:5173/ on the Mac. The Mac's SSH tunnel forwards that port to the devbox.

A push to main updates it. On the devbox, `pull-main-checkouts` pulls the main checkout, the dev server reloads by itself, and `scripts/after-pull` applies migrations and restarts the API server. The first setup on a new machine is `scripts/install-service`.

To put the public site back: add the push trigger to `.github/workflows/pages.yml`, turn GitHub Pages on for the repository, and uncomment the `/playground/` route in the devbox Caddyfile. Until then "My own Claude Code" does not work for a friend, because their connector cannot reach the API server.
