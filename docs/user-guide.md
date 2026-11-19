# User guide

Use this tool to answer questions like “How long did this task take?” and “What changed when I ran it again?” You give a coding agent an instruction, or **prompt**. The program that drives the model and gives it tools is its **harness**. The benchmark records one attempt as a **run**. Two agents given the same prompt can read different context, use different tools and produce different work. [Glossary of terms and dashboard labels](glossary.md)

[Set up](#set-up) · [First run](#record-and-inspect-your-first-run) · [Providers](#choose-a-provider-and-model) · [Terminal workflows](#use-the-terminal) · [Comparisons](#repeat-and-compare) · [Suites and checks](#run-a-suite-and-check-the-work) · [Dashboard](#read-the-dashboard) · [Files and deletion](#find-files-and-remove-a-run) · [Troubleshooting](#troubleshoot)

## Set up

Use a terminal on macOS or Linux, or a Linux shell in WSL on Windows. You need Git to clone the project and Python 3.11 or newer. The Python that ships with macOS is older, so install a newer one. The dashboard is already built. Running it requires neither Node nor Python package installation.

```sh
git clone https://github.com/danphillips-cloud/meta-benchmark.git
cd meta-benchmark
python3 --version
```

Install the Muse Code CLI for the first exercise, then use `command -v muse` to check that your shell can find it. Echo works offline through that CLI. For a real Muse subscription run, use `muse login` and sign in to your subscription. The benchmark defaults to Wonder Full, which Meta includes on its Power Usage and Maximum Usage plans. Choose an available model explicitly if your plan differs. [Meta setup](https://dev.meta.ai/docs/overview) · [Wonder availability](https://dev.meta.ai/docs/muse-wonder)

## Record and inspect your first run

1. From the repo root, run `./run-muse --provider echo "hello"`. Echo exercises the recorder without asking a model to solve anything. Look for the reply, a wall time and the task-check line. “Model metrics unavailable” is expected here.
2. Follow the local address printed after **UI**. The same line identifies the run. In an offline echo check with this guide’s prompt, the reply was `echo: hello`. Open **Runs** and click its row. In **Overview**, read the prompt, reply, execution status and **Task** chip. **Completed** describes execution. **Not checked** means the runner evaluated no task requirement. [Execution and task status](glossary.md#execution-and-task-status)
3. To inspect the saved record, substitute the printed ID for `RUN_ID` in `python3 -m json.tool muse-runs/RUN_ID/report.json`. Find `wall_ms`, `reply` and `task_validation`. A JSON `null` means that field has no value. It cannot supply a zero for a calculation.
4. With a Muse subscription and access to standard Wonder, try a one-shot prompt, a task described in one instruction:

```sh
./run-muse --provider meta --model muse-wonder-1.0 --minimal "What is 2+2?"
```

Read the answer yourself, then look at how many calls were recorded. The answer to the arithmetic question gives you a simple correctness check independent of the timing. For a task that writes files, try the [stopwatch walk-through](../README.md#2-run-one-real-test) and operate the controls yourself.

## Choose a provider and model

The **provider** flag selects how the benchmark runs the prompt. The **model** is the system asked to answer. The choice changes what work is possible, which account pays and which fields you can compare. [Provider, model and harness](glossary.md#agent-harness-provider-and-model)

| Provider | Setup and billing | Work and measurements |
|---|---|---|
| `echo` | Nothing to install. No model charge. | Echoes the prompt in a fresh workspace. Useful for learning the recorder. |
| `meta` | Muse CLI with subscription sign-in for the workflows here. The runner reads plan allowance when available. | Coding agent in a workspace. Its session log can supply call times, tokens, tools, approvals and request sizes. |
| `claude-code` | Install the `claude` CLI. The runner supplies an API key for the chosen endpoint. A Claude subscription login alone does not satisfy this check. | Runs Claude Code noninteractively in bare mode with Bash, Edit and Read allowed. Reports can include total API time, usage and cost. Per-call model time and per-call output are unavailable. [Claude Code authentication](https://code.claude.com/docs/en/authentication) · [Programmatic execution](https://code.claude.com/docs/en/headless) |
| `anthropic` | API key for the chosen endpoint. No agent CLI needed. | Sends one Messages API request. It can return text or code in a reply. There is no agent workspace or tool loop to create and run that code. Model duration here is the elapsed HTTP request. [Messages API](https://platform.claude.com/docs/en/api/messages/create) |
| `codex` | Install the Codex CLI and establish a saved login. ChatGPT login can consume plan usage. API-key login can incur API charges. Supply `--model` or `BENCH_CODEX_MODEL`. | Starts an ephemeral workspace session. The completed turn can supply a reply and aggregate tokens. Cost, model time and per-call detail stay unknown. [Local Codex setup](openai.md) · [OpenAI authentication](https://learn.chatgpt.com/docs/auth) · [Noninteractive execution](https://learn.chatgpt.com/docs/non-interactive-mode) |

For the `anthropic` and `claude-code` routes, a model ID beginning with `muse-` selects Meta's compatible endpoint and `MODEL_API_KEY`. Other IDs select Anthropic and `ANTHROPIC_API_KEY`. A route accepting a model name does not establish access to it. Wonder Full is subscription-only in Muse Code. Use the [configuration table](../README.md#configuration) for defaults and endpoint overrides.

**Context** means the instructions and other information that accompany your prompt. Muse's `--minimal` suppresses reminders and foreign personal context. Codex minimal mode disables specific instruction and integration sources. Claude Code always runs bare here. The direct API request contains the user prompt regardless of the context label. A shared prompt does not guarantee identical input. [Context modes](glossary.md#context-and-request-lanes) · [Codex compatibility details](openai.md#context-and-cli-compatibility)

## Use the terminal

| To do this | Use |
|---|---|
| Send one prompt | `./run-muse --provider echo "hello"`. Quote the prompt so the shell preserves its text. Use `--provider` and `--model` to select a route and model. |
| Enter prompts one at a time | `./run-muse` starts a prompt loop. Use `/help`, `/mode` to see the current mode, or `/mode single`, `meta`, `claude` or `custom` (for example, `/mode meta`). Each submitted prompt launches new work. `/quit` exits. |
| Change context or time limit | `--minimal` changes context on supported agent routes. `--timeout 60` sets a per-run limit in seconds. Defaults are 1,800 seconds for Muse/echo and 300 for Claude Code, direct API and Codex. |
| Stop an agent run | Press Ctrl+C. Inspect the terminal status and partial workspace. A single prompt returns exit code 0 for completed, 130 for interrupted and 1 for other unsuccessful outcomes. |
| Record without the page | `RUN_MUSE_NO_UI=1 ./run-muse --provider echo "hello"`. For a separate local page choose an unused port with `PORT`, for example `PORT=9876 ./run-muse --provider echo "hello"`. |
| Record an interactive Muse turn | Start a regular Muse session in another terminal. Run `./run-muse --watch` for the newest log or `./run-muse --watch SESSION_ID`. This reads the session and writes benchmark records. Ctrl+C stops watching. |
| Import existing interactive turns | `./run-muse --retro` scans Muse logs, skips already represented turns and can repair previously unknown outcomes. Watch tracks seen turns within its current invocation. Reattaching a watcher can record a turn again. |
| Inspect all flags | `./run-muse --help`. Watch and retro take no prompt or comparison. Suite mode takes a manifest and cannot be combined with a prompt, watch, retro or compare. |

An imported turn closes when the next prompt begins or the session ends. Its clock runs from prompt acceptance to the last recorded activity in that turn. Time spent thinking about your next prompt is excluded. The importer skips segments without a model call or usable time boundaries. A missing terminal outcome can leave the status **unknown**. [Run, session and turn](glossary.md#run-session-and-turn)

## Repeat and compare

Save one prompt in a shell variable so each attempt gets the same wording. Run the single command again for independent attempts. For a grouped comparison, the following example uses two Meta models on a Muse subscription:

```sh
PROMPT="Explain in one sentence why the sky looks blue."
./run-muse --minimal --model muse-wonder-1.0 "$PROMPT"
COMPARE_META=meta:muse-wonder-1.0,meta:muse-spark-1.3 ./run-muse --minimal --compare meta --repeat 3 "$PROMPT"
```

Each provider/model pair is a **leg**. One **round** runs each leg once. Two legs times three rounds launches six runs. Compare defaults to one round. Even rounds reverse the order. Add `--race` only with `--compare` to run each round's legs together. They then share the machine and may draw on the same usage window. [Comparison terms](glossary.md#comparison-set-leg-and-round)

The default `meta` preset has four legs, including Wonder Full. The default `claude` preset compares standard Wonder and Claude through Claude Code using API keys. The default `custom` preset mixes Muse and paid Claude Code legs. Inspect the pairs in the [configuration table](../README.md#configuration) before launching. For a Codex leg, see the [three-provider example](openai.md#put-all-three-on-one-prompt).

Use **Runs** to pick two or three attempts, or open the set in **Compare** to see each leg's median. Keep the same prompt, provider, context and harness version when investigating variation within one setup. Review failures and task checks alongside the wall-time range and sample size. Multiple repeats describe the runs you collected. [Median, n and range](glossary.md#median-n-and-range)

## Run a suite and check the work

A **manifest** is a JSON file listing prompts and settings. A **suite** runs that list. Save this example as `echo-check.json` in the repo root:

```json
{
  "settings": {"repeat": 1},
  "prompts": [
    {
      "name": "echo-greeting",
      "provider": "echo",
      "prompt": "hello",
      "checks": {"reply_contains": ["hello"]}
    }
  ]
}
```

```sh
./run-muse --manifest echo-check.json --dry-run
./run-muse --manifest echo-check.json --resume
```

The preview shows planned work without starting it. The second command runs echo and writes progress to `echo-check.state.json`. Open its run in Overview and compare the execution and task labels. To see a failed check, change the required substring to `goodbye`, keep the prompt, then repeat the second command. The changed check makes the entry eligible to run again. A completed echo can still fail the check and make the suite exit with code 1.

For file-producing tasks, add `"files_exist": ["answer.txt"]` inside `checks`. Paths are relative to the run's workspace. All configured checks must pass. Reply matching is case-sensitive and allows a substring anywhere. A file containing the wrong answer can pass an existence check. Read the file or exercise the requested behaviour before treating the task as solved. Checks run after the timed work. [Task results](glossary.md#execution-and-task-status)

- Each entry needs a unique `name` and a `prompt` or a `file` relative to the manifest. Entries can choose `provider`, `model`, `minimal`, `skip`, checks and timeout. CLI `--model` fills missing models only on entries matching the CLI provider. Specify context per entry.
- `--suite` is an alias for `--manifest`. With no filename it uses [golden-prompts.json](../golden-prompts.json). The [model benchmark](../model-benchmark.json) has six checked tasks with three repeats each. Preview either with `--dry-run`. These suites use models when executed.
- CLI `--repeat` overrides the settings value. The suite default is three. For timeouts the first available value wins in this order: CLI, entry, suite setting, provider default. `settings.concurrency` controls how many entries may run together.
- `--resume` reuses completed attempts by entry name and round if required checks still match and passed. Changing the prompt or model under the same name can reuse earlier results. Add `--fresh --resume` to start a new suite and replace the saved progress. Without resume, no state file is written.
- `max_runtime_seconds` limits new starts and can shorten the next entry's timeout. `max_cost_usd` counts recorded charges, including earlier attempts on resume. Unpriced runs, including Codex, can incur charges outside that total. Work already in flight can carry spending past the threshold. A suite cannot guarantee an account spending cap.

## Read the dashboard

Follow the **UI** address in the terminal. The page refreshes every two seconds. **Getting started** in the sidebar reopens the walkthrough. Select a run before exploring its detail views.

### Overview

Read the prompt, reply, execution status and task chip first. Compare **Wall time** with **Model time**, **Tools**, **Approval wait** and **Muse**. **Why was this slow** ranks recorded contributors. Click **Watch in Replay** on a finding to inspect its timing. After three earlier completed matches you may see a **usual** time. Recent runs and provider/model medians refer to the scope beneath the selected run. Shared filters change that history. **Copy run card** gives a short summary. **Download repro pack** includes more details such as the prompt and recorded steps. [Timing labels](glossary.md#time-measurements) · [Usual and fastest](glossary.md#usual-fastest-and-change)

### Runs

Filter by prompt text, provider or date to find attempts. Runs also offers model, status, mode and version filters. The model picker lists Meta models. Use provider to find other agents. Click a column heading to sort or a row to open Overview. Tick two or three rows and choose **Compare selected runs**. The summary covers the full run history, including when the table is filtered. [Scope and totals](glossary.md#scope-and-totals)

### Compare

For individual picks, the first run is the reference. A difference is the first value minus the other run's value. A negative wall-time difference means the first took less time. Expand **Show prompts and replies** to check that the tasks and outputs are comparable. A comparison set adds per-leg results by round and medians for completed runs. Read each metric's **n**, the failures and the task-check counts before interpreting a **fastest** badge. Suite runs appear in Runs and can be picked manually. [Comparison metrics](glossary.md#usual-fastest-and-change)

### Timeline

Use the chart to spot a long model call or rising input tokens. The chart runs oldest to newest and the call table starts with the newest. The full timeline lists events oldest first. Its time-to-next-step column measures the gap between recorded events. Use the model-time column for a recorded model call's duration. An empty chart is expected for Codex and Claude Code. [Call timing and gaps](glossary.md#time-measurements)

### Replay

Play, pause, scrub or click a recorded step. **Speed** changes playback only. The counters advance as timed calls land. Tool and approval intervals show where recorded activity overlapped. For two legs in a comparison round, use **Replay both** when it appears. In paired replay the runs share an elapsed-time ruler starting at each trace's first timestamp. Their real starts can differ. Untimed steps cannot be positioned on that ruler. [Replay clock](glossary.md#replay-clock)

### X-ray

Use X-ray on a Muse run with input traces to see what the model received. Compare the user's prompt bytes with the whole first request, then follow **Conversation so far** and other groups across calls. Each bar scales with request size and each segment represents a share. An omitted group can leave the picture partial. Read the separate token table for token counts. [Context and request lanes](glossary.md#context-and-request-lanes)

### Radar

Run the same suite across harness versions to look for a change. A row groups matching prompt text, provider, model and context. Matching runs outside a suite can contribute too. The **Golden suite only** filter limits the table to groups with a suite entry. Each version cell shows completed observations. A change appears when two known versions each have enough measured runs. Use **Download report** to save the numbers with their method for all groups, including any hidden by the filter. The change alone cannot identify its cause. [Version change](glossary.md#usual-fastest-and-change)

### Export

**Export CSV** writes one row per recorded call in the selected run with prompt, model, wire time, input and output. A run without calls can produce just headers. **Export JSON** saves the fetched dashboard data, including summaries of other runs and their prompts. Review it before sharing. To preserve generated files, copy the workspace itself. [File formats](glossary.md#files-and-formats)

## Find files and remove a run

Use the ID printed on the UI line or shown in the saved report. The launcher writes beneath the repo root. A typical fresh Muse run looks like this:

```text
muse-runs/
  index.jsonl
  <run-id>/
    report.json
    prompt.md
    events.jsonl
    stderr.log
    workspace/
```

The report holds the final status, reply, measurements and checks. The index can have both a running and a final record for one ID. The page displays the latest. The events file holds provider output where available, and stderr holds diagnostic text. Generated work lives in the workspace. An interrupted run may contain partial files. A direct API request has no workspace. Watch and retro write benchmark copies of turns from external Muse session logs, normally under `~/.local/share/muse/sessions/`. A missing original log can limit details reconstructed later.

To remove a result, copy any files you want to keep, select it in **Runs**, choose **Delete session** and confirm. For several, tick the rows and use **Delete selected**. The header checkbox selects across the filtered results, including later pages. Existing selections can survive a filter change, so check the count or **Clear selection** first. Deletion removes the benchmark directory, including the workspace, and its index entries. It leaves external Muse logs and separate suite state files in place. Active unfinished runs are protected.

## Troubleshoot

| Symptom | What to check |
|---|---|
| CLI missing or model unavailable | Use `command -v muse`, `command -v claude` or `command -v codex` for the provider you chose. Check the model ID, account access and endpoint. For Codex check `codex login status` and specify a model. |
| Page unavailable | Read the launcher's terminal message. Recording can continue without a page. Inspect the report directly or choose a different unused port with `PORT`. |
| Dash, empty chart or unknown cost | Check provider and run status first. Echo has no model calls, Codex supplies turn totals, and X-ray requires Muse input traces. For plan usage, open the before/after detail. For USD, check the source and whether required counts and rates exist. [Cost and allowance](glossary.md#cost-and-allowance) |
| Failed, timed out or stopped for approval | Read the report's error and the end of stderr.log if present. Inspect partial work. For a timeout, review the task and configured cap. For an approval stop, identify the operation that required approval before trying a revised prompt. |
| Old run seems interrupted or unknown | A stale running entry with no report may display as interrupted. An imported turn needs an explicit logged outcome. Retro can repair it once the log contains one. |
| Completed, but a check failed | Inspect the exact reply substring or relative workspace filename. Check case, location and contents. The task-check list in report.json identifies which condition failed. |
| Resume skipped a different model or prompt | Check the manifest state file's entry name and round. Start with `--resume --fresh` when you want new measurements. |
| No usual, fastest or Radar change | Check matching prompt/context, completed counts and nonmissing measurements. Overlapping wall-time ranges can prevent a fastest badge even with several runs. [Eligibility rules](glossary.md#usual-fastest-and-change) |
