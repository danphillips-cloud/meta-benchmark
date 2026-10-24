# meta-benchmark

A local benchmark tool for Muse Code.

When a Muse run feels slow, the cause could be the model, the size of the context, or local work between calls. I built this to measure each one from Muse's own logs instead of guessing.

It runs prompts through Muse or Claude Code from a terminal prompt and records every model call. A local web page shows how long each call took, how much of the run was local overhead, and how many tokens went in and out.

## Requirements

Muse Code on the `PATH` with a subscription login, Python 3, and macOS or Linux. No packages to install. Everything uses the Python standard library.

Claude Code runs also need the `claude` CLI on the `PATH` and an API key for the model's endpoint. Raw API runs need that key too. See Providers below.

## Quick start

```sh
muse login
git clone https://github.com/danphillips-cloud/meta-benchmark.git
cd meta-benchmark
./run-muse
```

## API keys

Muse runs use the `muse login` subscription and need no key. Claude Code and raw API runs do. Put the keys in a `.env` file in the repo root:

```sh
MODEL_API_KEY=your-meta-key
ANTHROPIC_API_KEY=your-anthropic-key
```

`.env` is gitignored. Lock it to your user with `chmod 600 .env`. A variable already set in the shell wins over the file. Each Claude Code run gets only the one key its endpoint needs.

## How to use

1. Start the tool with `./run-muse`. Wait for the `muse>` prompt in the terminal. The results page opens in the browser on its own. If it does not, open http://127.0.0.1:8765 by hand.
2. Type a prompt at `muse>` and press Enter. One prompt is one run. It can be a one-line question or a multi-step build.
3. Read the reply in the terminal. One summary line prints under it with wall time, model time, and token counts.
4. Switch to the browser while the run is still going. The page refreshes every two seconds, so completed model calls appear before the run finishes.
5. Use the Session dropdown at the top to pick the run to inspect. The cards, prompt, reply, and call table all follow that pick.
6. Read the split. Check Wire against Total to see whether the model or the local host took the time, then check the input tokens on the last call. See Reading the numbers below.
7. Click a row in Sessions, grouped to jump to that run. To compare two runs, pick the second one under Compare sessions and read the deltas.
8. Open Full timeline and use Show full timeline to see every recorded step in order. Use Export CSV or Export JSON to save the selected run, or Copy summary to paste it into a report.
9. Go back to the terminal and type the next prompt. Run as many as needed, one at a time.
10. Type `/quit` to leave. To stop a run mid-flight, press `Ctrl+C` once. The run is recorded as `interrupted` and the prompt comes back.

## Usage

```sh
./run-muse "write a python script that counts lines in a file, then run it on itself"   # multi-step, several calls
./run-muse --minimal "what is 2+2"          # baseline: fixed cost with controlled context
./run-muse --timeout 300 "what is 2+2"      # default is 1800 seconds
./run-muse --provider claude-code --model claude-sonnet-5-5 "what is 2+2"
./run-muse --provider anthropic --model claude-sonnet-5-5 "what is 2+2"   # one raw API call, no agent
./run-muse --compare "what is 2+2"          # same prompt across COMPARE_MODELS
./run-muse --compare --repeat 3 "what is 2+2"   # 3 rounds, order alternates each round
```

## Providers

`--provider` picks the harness. `meta` runs Muse under the subscription login. It is the default. `claude-code` runs Claude Code headless with `--bare`, so hooks, plugins, CLAUDE.md, and memory stay out of the run. `anthropic` makes one raw Messages API call with no agent context.

The model id picks the endpoint for `claude-code` and `anthropic` runs. A `muse-*` model goes to `META_BASE_URL` (default `https://api.meta.ai`) with `MODEL_API_KEY`. Any other model goes to `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`) with `ANTHROPIC_API_KEY`. Claude Code can run either vendor's model this way. That gives three clean comparisons. Model against model in Claude Code. Harness against harness on one Meta model. Bare API call against bare API call.

Meta's API serves `muse-wonder-1.0`. `muse-wonder-full-1.0` only works through the Muse subscription, so the default compare set uses `muse-wonder-1.0` on both harnesses.

A bare API run and an agent run measure different things. The page labels provider and model on every run. I do not read them as like for like.

## Reading the numbers

**Wire** is one model call, start to finish, from the `duration_ms` field on Muse's `model_completed` log record. **Total** is the wall time of the whole harness process. The gap is local overhead. If the two are close, the model took the time. If the gap is large, the local host did.

Claude Code does not report per-call time, so Wire and Slowest call show `–` on those runs. Model total uses its reported API time instead. Per-call output tokens are blank on Claude Code runs for the same reason. Run totals come from its final result event.

Token cards show the last call only, not run totals. Overhead share is provisional while a run is live.

Each Muse run carries roughly 30k tokens of agent context before the prompt. That fixed cost lands on every call.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8765` | Results page port |
| `RUN_MUSE_NO_UI` | unset | `1` skips the web page |
| `MODEL_API_KEY` | unset | Key for `muse-*` models on the Meta endpoint. Never logged |
| `ANTHROPIC_API_KEY` | unset | Key for Claude models. Never logged |
| `META_BASE_URL` | `https://api.meta.ai` | Endpoint for `muse-*` models |
| `COMPARE_MODELS` | `meta:muse-wonder-1.0,claude-code:muse-wonder-1.0,claude-code:claude-sonnet-5-5` | `provider:model` pairs for `--compare` |
| `ANTHROPIC_MAX_TOKENS` | `8192` | Output cap for raw `anthropic` runs |
| `BENCH_CLAUDE_MODEL` | `claude-sonnet-5-5` | Default model for `anthropic` and `claude-code` runs |

## Data and privacy

All run data lives in `muse-runs/`, which is gitignored. Each run gets its own folder and workspace, so files the model creates never land in the repo. The server binds to `127.0.0.1` and rejects foreign `Host` and `Origin` headers. API keys are stripped from the Muse child process, so a subscription run can't fall back to API billing. Claude Code runs get only the one key their model's endpoint needs, set by the launcher.

## Tests

```sh
python3 test_tool.py
```

## Licence

[MIT](LICENSE). meta-benchmark is an unofficial tool, not made by or affiliated with Meta.
