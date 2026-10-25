# Agent rules

Rules for coding agents working in this repo (Muse Code reads this file, Claude Code reads it through `CLAUDE.md`).

## What this is

A stopwatch for Muse Code. `run-muse` runs prompts and records each run in `muse-runs/`. `server.py` serves the results page on 127.0.0.1. `muse_log.py` parses Muse session logs. The page is React in `frontend/src`, built into `web/app.js`.

## Commands

```sh
python3 test_tool.py                          # Python tests
cd frontend && npm ci && npm test             # frontend tests
cd frontend && npm run build                  # rebuild web/app.js
./run-muse --minimal "what is 2+2"            # free Muse run
./run-muse --provider echo "hi"               # offline run, no model
```

## Rules

- **Python is stdlib only** and must run on Python 3.9 (the macOS system Python). CI tests 3.9 and 3.12.
- **No new npm packages.** Pin exact versions if one is ever approved.
- **`server.py` stays read-only.** It never writes run data, never uses a key, and binds 127.0.0.1 only. Bump `VERSION` in `server.py` once per change to the server or page, so running launchers restart a stale server.
- **After any frontend change, run `npm run build` and commit `web/app.js`.** CI fails if the committed bundle doesn't match a fresh build.
- **Both test suites must pass** before a change is done. Add tests for new behaviour.
- **Never estimate a number.** If the log didn't record it, it's `None` and the page shows a dash.
- **No paid runs** unless the user asks for that exact run. `--provider claude-code`, `--provider anthropic`, `--compare claude` and `--compare custom` bill API keys. Muse and echo runs are free.
- **Never read, print or create `.env`.** It holds API keys.
- **Never probe or kill anything on port 8765.** It's the user's own page. Tests use random free ports.
- **No em dashes or semicolons in text users see** (README, page, terminal output). Short sentences.
- **`main` is protected.** Work on a branch and open a PR. Don't commit, push or merge unless asked.
- Plans and notes live in `.docs/`, which is gitignored. When working from a plan, mark each finished step with ✓ and flag anything you skip.
