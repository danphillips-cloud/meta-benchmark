# meta-benchmark

A local benchmark tool for Muse Code.

When a Muse run feels slow, the cause could be the model, the size of the context, or local work between calls. I built this to measure each one from Muse's own logs instead of guessing.

It runs prompts through Muse from a terminal prompt and records every model call. A local web page shows how long each call took, how much of the run was local overhead, and how many tokens went in and out.

## Requirements

Muse Code on the `PATH` with a subscription login, Python 3, and macOS or Linux. No packages to install. Everything uses the Python standard library.

## Quick start

```sh
muse login
git clone https://github.com/danphillips-cloud/meta-benchmark.git
cd meta-benchmark
./run-muse
```

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
./run-muse "what is 2+2"                    # one prompt, no loop
./run-muse --minimal "what is 2+2"          # controlled context for repeatable tests
./run-muse --timeout 300 "what is 2+2"      # default is 1800 seconds
```

## Reading the numbers

**Wire** is one model call, start to finish, from the `duration_ms` field on Muse's `model_completed` log record. **Total** is the wall time of the whole `muse exec` process. The gap is local overhead. If the two are close, the model took the time. If the gap is large, the local host did.

Token cards show the last call only, not run totals. Overhead share is provisional while a run is live.

Each Muse run carries roughly 30k tokens of agent context before the prompt. That fixed cost lands on every call.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8765` | Results page port |
| `RUN_MUSE_NO_UI` | unset | `1` skips the web page |

## Data and privacy

All run data lives in `muse-runs/`, which is gitignored. Each run gets its own folder and workspace, so files the model creates never land in the repo. The server binds to `127.0.0.1` and rejects foreign `Host` and `Origin` headers. API keys are stripped from the Muse child process, so a subscription run can't fall back to API billing.

## Tests

```sh
python3 test_tool.py
```

## Licence

[MIT](LICENSE). meta-benchmark is an unofficial tool, not made by or affiliated with Meta.
