# meta-benchmark

A local benchmark tool for Muse Code.

When a Muse run feels slow, the cause could be the model, the size of the context, or local work between calls. I built this to measure each one instead of guessing.

It runs prompts through Muse or Claude Code and records every model call. A local web page shows model time, local overhead, and tokens for each run.

## Requirements

Python 3 and macOS or Linux. No packages to install. Muse Code with a subscription login. Claude Code runs also need the `claude` CLI.

## Quick start

```sh
muse login
git clone https://github.com/danphillips-cloud/meta-benchmark.git
cd meta-benchmark
./run-muse
```

## API keys

Muse runs need no key. Claude Code and raw API runs read keys from a `.env` file in the repo root, which is gitignored:

```sh
MODEL_API_KEY=your-meta-key
ANTHROPIC_API_KEY=your-anthropic-key
```

## How to use

**In the terminal**

1. Run `./run-muse`. The results page opens at http://127.0.0.1:8765.
2. Type a prompt at `muse>` and press Enter. Each prompt is one run.
3. The reply prints with one summary line: wall time, model time, tokens.
4. `Ctrl+C` stops a run and records it as `interrupted`. `/quit` exits.

**On the page**

The page refreshes every two seconds, so calls show up while a run is live.

| To | Use |
|---|---|
| Pick a run | **Session** dropdown, or click a row in **Sessions, grouped** |
| See where the time went | **Wire** vs **Total** cards. See Reading the numbers |
| Compare two runs | **Compare sessions** |
| See every step | **Full timeline**, then **Show full timeline** |
| Save a run | **Export CSV**, **Export JSON**, or **Copy summary** |

## Usage

```sh
./run-muse "write a python script that counts lines in a file, then run it on itself"
./run-muse --minimal "what is 2+2"                # controlled context
./run-muse --provider claude-code "what is 2+2"
./run-muse --provider anthropic "what is 2+2"     # one raw API call, no agent
./run-muse --compare --repeat 3 "what is 2+2"     # COMPARE_MODELS, 3 rounds
```

## Providers

| `--provider` | Runs |
|---|---|
| `meta` (default) | Muse Code |
| `claude-code` | Claude Code headless, `--bare` |
| `anthropic` | One raw Messages API call |

For `claude-code` and `anthropic`, a `muse-*` model goes to Meta's API and anything else goes to Anthropic. Meta's API serves `muse-wonder-1.0`.

## Reading the numbers

**Wire** is one model call. **Total** is the whole run. The gap is local overhead.

Claude Code doesn't report per-call time, so its Wire column is blank and Model total uses its API time.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `MODEL_API_KEY` | unset | Key for `muse-*` models on Meta's API |
| `ANTHROPIC_API_KEY` | unset | Key for Claude models |
| `COMPARE_MODELS` | `meta:muse-wonder-1.0,claude-code:muse-wonder-1.0,claude-code:claude-sonnet-5-5` | `provider:model` pairs for `--compare` |
| `BENCH_CLAUDE_MODEL` | `claude-sonnet-5-5` | Default model for `claude-code` and `anthropic` |
| `META_BASE_URL` | `https://api.meta.ai` | Meta API endpoint |
| `ANTHROPIC_MAX_TOKENS` | `8192` | Output cap for `anthropic` runs |
| `PORT` | `8765` | Results page port |
| `RUN_MUSE_NO_UI` | unset | `1` skips the web page |

Run data stays in `muse-runs/`, which is gitignored. The page is served on `127.0.0.1` only.

## Tests

```sh
python3 test_tool.py
```

## Licence

[MIT](LICENSE). Unofficial tool, not affiliated with Meta.
