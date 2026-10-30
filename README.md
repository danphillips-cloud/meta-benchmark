# meta-benchmark

A stopwatch for Muse Code, Meta's coding agent. Give it a prompt and it shows where the time went: how long the model spent thinking, and how much was Muse's own overhead. One command, runs locally, nothing to install beyond Muse Code. It tells you which part is slow before you guess.

You can also compare models on the same prompt: two Meta models, or Meta against Anthropic.

Work in progress. I've tested it on macOS with Muse Code 1.4.13. Expect rough edges, and open an issue if something breaks.

## Requirements

Python 3.9 or newer on macOS or Linux, and Muse Code. Claude Code runs also need the `claude` CLI.

## Getting started

### 1. Clone and sign in

```sh
git clone https://github.com/danphillips-cloud/meta-benchmark.git
cd meta-benchmark
muse login    # first time only
```

That is the whole install for everything below. These runs use a Muse subscription. No API key, no Node.

### 2. Run one real test

Skip `what is 2+2` as a first run. It makes one model call, so the page has almost nothing to split. Start with one proper one-shot prompt instead. One-shot means everything the agent needs sits in a single prompt, with no follow-up.

```sh
./run-muse --minimal "Read server.py and muse_log.py in this repo. Trace how one finished Muse run gets from a session log on disk to the numbers on the Overview page. Name each function in the chain in order, with file and line numbers. Say which function works out the model, tools, approval wait and Muse time split. Do not change any files. Keep the answer under 300 words, and flag anything you could not confirm from the code."
```

The prompt is built to be checkable in one pass:

- **Goal first.** Trace one run from a log file to the page.
- **Files named.** The agent reads two files, not the whole repo.
- **Evidence demanded.** A function name and a line number for each step.
- **Hard limits.** No file changes. Under 300 words.
- **An honesty check.** Anything unconfirmed gets flagged, not guessed.

`--minimal` drops reminders and personal context, so a repeat of the same command measures the same work.

The terminal prints each model call as it finishes, then the reply with one summary line. I recorded this run on 2026-10-29 with Muse Code 1.4.14:

```text
[meta/muse-wonder-full-1.0] wall 72978 ms · model 69696 ms · in 276136 · out 3377 · 6 call(s) · completed
```

Six model calls. Model time was 69.7 s of the 73.0 s wall. Tools took 0.4 s and Muse itself 2.9 s. Your numbers will differ. The split is the point.

### 3. Read it on the page

The results page opens at http://127.0.0.1:8765 (or your `PORT`). If another app already has that port, the launcher says so and the run carries on without the page. Use another port with `PORT=8766 ./run-muse`.

Open Overview for the time split and the plain-words summary of the run. Open Timeline for every recorded step in order. Open Replay and press play to watch the run back on its recorded clock, calls landing where they landed.

Then check the answer itself. Pick one claim from the reply, open the cited file at the cited line, and confirm it. The stopwatch says where the time went. It does not say the answer is right.

### 4. Run it again

One run is a timing. A repeat is data. Run the same command again and Overview gains your usual time for the same prompt. To put two Meta models on the same work, compare them:

```sh
./run-muse --minimal --compare meta --repeat 3 "Read server.py and muse_log.py in this repo. Trace how one finished Muse run gets from a session log on disk to the numbers on the Overview page. Name each function in the chain in order, with file and line numbers. Say which function works out the model, tools, approval wait and Muse time split. Do not change any files. Keep the answer under 300 words, and flag anything you could not confirm from the code."
```

Each round is two full runs of the prompt. The Compare page reads medians over the rounds, so one slow call cannot carry the result.

For an open-ended session, run `./run-muse` with no prompt. Type a prompt at `muse>` and press Enter. Each prompt is one run, recorded the same way.

Ready for a longer build? The [getting started guide](docs/getting-started.md) has five one-shot app prompts, plus a frame for writing your own.

## Usage

| Mode | Command |
|---|---|
| Single (default) | `./run-muse` |
| Meta vs Meta | `./run-muse --compare meta` |
| Meta vs Claude | `./run-muse --compare claude` |
| Custom | `./run-muse --compare custom` |

Single and Meta vs Meta use your Muse subscription. Meta vs Claude bills your API keys per token. So does Custom by default, because its default legs use Claude Code.

Every paid run prints `Paid run: uses MODEL_API_KEY` (or `ANTHROPIC_API_KEY`) before it starts, and stops after 5 minutes. Claude Code runs print a line as each call lands, like `call 1 · arrived +10.8 s · 29k in`, plus the tool now running. That time is the gap since the previous stream event arrived. Claude Code reports no per call duration, so the line never claims model time. The page shows the same calls, timeline, and live state while the run is going.

`--compare meta --repeat N` runs N rounds, alternating the order each round.

`./run-muse --watch` times your own interactive Muse session, read-only. Run Muse normally in another terminal.

`--minimal` drops reminders and personal context so runs repeat cleanly. It doesn't make the prompt much smaller: Muse's own system prompt is ~27k tokens either way.

In the prompt loop, `/mode meta`, `/mode claude` and `/mode single` switch mode, and the prompt shows it, for example `muse[meta]>`. `/help` lists commands. `Ctrl+C` stops a run and records it as `interrupted`. `/quit` exits.

### Manifests

Stage a whole benchmark in one JSON file, then run it in one go.

```sh
./run-muse --manifest bench.json --dry-run   # list what would run, run nothing
./run-muse --manifest bench.json --resume    # run it, keep progress in bench.state.json
```

`--suite` is the older name for the same thing, and `golden-prompts.json` still works as before. The file holds a `prompts` list and an optional `settings` block.

```json
{
  "settings": {
    "concurrency": 1,
    "timeout_seconds": 1800,
    "max_cost_usd": 10.0,
    "max_runtime_seconds": 3600,
    "pricing": {"input_per_mtok": 4.0, "output_per_mtok": 20.0}
  },
  "prompts": [
    {"name": "sky", "prompt": "Why is the sky blue?", "minimal": true},
    {"name": "big", "file": "prompts/big.md", "timeout_seconds": 3600, "skip": false}
  ]
}
```

Each entry needs a unique `name` and either a `prompt` or a `file`, relative to the manifest. `provider`, `model`, `minimal`, `skip` and `timeout_seconds` are optional per entry. The `--timeout` flag beats a per entry timeout, which beats the settings timeout, which beats the provider default.

Budgets stop new entries from starting. They never kill a run in flight, because a run's cost is only known when it ends. The next entry timeout also shrinks to fit the runtime budget left. `--dry-run` prints every entry, marks paid ones, and says what the budgets count. Read it before a big paid run.

`--resume` writes progress to a state file beside the manifest. Stop partway, run the same command again, and completed entries are skipped under the same suite. Failed and timed out entries run again. Add `--fresh` to ignore saved progress. Without `--resume` nothing changes from before, and no state file is written. The runner reads the manifest once at the start, so edit it only between runs.

### Providers

| `--provider` | Runs |
|---|---|
| `meta` (default) | Muse Code |
| `claude-code` | Claude Code headless, `--bare` |
| `anthropic` | One raw Messages API call |

For `claude-code` and `anthropic`, a `muse-*` model goes to Meta's API and anything else goes to Anthropic. Meta's API serves `muse-wonder-1.0`.

### API keys

Only Claude Code and raw API runs need keys. Put them in a `.env` file in the repo root. It's gitignored.

```sh
MODEL_API_KEY=your-meta-key
ANTHROPIC_API_KEY=your-anthropic-key
```

## The page

The page refreshes every 2 seconds and follows a run in progress, so model calls show up as they finish.

- **Overview** shows one run: wall time split into model, tools, approval wait and Muse, a plain-words "What happened" summary, a chart of each model call, and your usual time for the same prompt.
- **Runs** logs every run. Sort and filter it, then click a row to open that run in Overview.
- **Compare** shows medians for a compare set, with the fastest marked.
- **Timeline** lists the model calls and every step Muse recorded, in order.
- **Replay** plays a run back on its recorded clock. Calls land where they landed, at a speed you pick.
- **X-ray** shows what Muse sent on each call, in recorded bytes.
- **Radar** shows median wall time per prompt across Muse versions, and the change between the two newest versions with enough runs.
- **Export** saves the selected run as CSV or JSON.

## Reading the numbers

**Wall** is the whole run. It splits into **Model** (the model thinking), **Tools** (commands Muse ran), **Approval wait**, and **Muse** (everything else Muse did). All four come from timestamps in Muse's own log. A dash means the log didn't record it.

Claude Code doesn't report per-call time, so its per-call columns are blank and Model uses its API time.

**Cost** shows on Overview, Runs and Compare. Claude Code reports its own cost, and that figure is used as-is, except for `muse-*` models where it prices from Anthropic's list, which is not a Meta price. For other runs, set your own rates and the cost is worked out from the recorded input and output tokens. Set `BENCH_PRICING` in `.env`, or `pricing` in a manifest, as USD per million tokens per model. A computed cost is marked "at your rates" and counts input and output tokens only. Cached and reasoning tokens stay unpriced, because no provider here records how they bill. No rates set means a dash. Nothing is ever estimated.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `MODEL_API_KEY` | unset | Key for `muse-*` models on Meta's API |
| `ANTHROPIC_API_KEY` | unset | Key for Claude models |
| `MUSE_MODEL` | `muse-wonder-full-1.0` | Default model for single runs |
| `MUSE_PROVIDER` | `meta` | Default provider for single runs |
| `COMPARE_META` | `meta:muse-wonder-full-1.0,meta:muse-wonder-1.0` | Pairs for `--compare meta` |
| `COMPARE_CLAUDE` | `claude-code:muse-wonder-1.0,claude-code:claude-sonnet-5-5` | Pairs for `--compare claude` |
| `COMPARE_MODELS` | `meta:muse-wonder-1.0,claude-code:muse-wonder-1.0,claude-code:claude-sonnet-5-5` | Pairs for `--compare custom` |
| `BENCH_CLAUDE_MODEL` | `claude-sonnet-5-5` | Default model for `claude-code` and `anthropic` |
| `BENCH_PRICING` | unset | Your rates as JSON, USD per million tokens per model, used to work out run cost |
| `META_BASE_URL` | `https://api.meta.ai` | Meta API endpoint |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Anthropic API endpoint |
| `MUSE_SESSIONS_DIR` | `~/.local/share/muse/sessions` | Where Muse writes session logs |
| `ANTHROPIC_MAX_TOKENS` | `8192` | Output cap for `anthropic` runs |
| `PORT` | `8765` | Results page port |
| `RUN_MUSE_NO_UI` | unset | `1` skips the web page |

Run data stays in `muse-runs/`, which is gitignored. The page is served on `127.0.0.1` only.

## Tests

```sh
python3 test_tool.py
```

## Developing the UI

The page is React, built into `web/app.js`, which is committed. Users don't need Node. To change the UI, edit `frontend/src`, then rebuild and commit `web/` with your change:

```sh
cd frontend
npm ci
npm test
npm run build
```

## Licence

[MIT](LICENSE). Unofficial tool, not affiliated with Meta.
