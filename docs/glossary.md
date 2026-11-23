# Glossary

Use this reference when a terminal message or dashboard label raises a question. For the steps to collect and inspect your own result, start with the [user guide](user-guide.md).

| Find a label | Jump to its meaning |
|---|---|
| A–C | [Agent, API, CLI](#agent-harness-provider-and-model) · [Allowance, at Meta list, at your rates](#cost-and-allowance) · [Approval wait](#time-measurements) · [Bare](#context-and-request-lanes) · [Cached, calls](#calls-and-tokens) · [Comparison set](#comparison-set-leg-and-round) · [Completed](#execution-and-task-status) · [Context](#context-and-request-lanes) · [CSV](#files-and-formats) |
| D–M | [Delta, fastest](#usual-fastest-and-change) · [Elapsed](#time-measurements) · [Failed](#execution-and-task-status) · [Full](#context-and-request-lanes) · [Harness](#agent-harness-provider-and-model) · [In, input](#calls-and-tokens) · [In flight](#replay-clock) · [Interrupted](#execution-and-task-status) · [JSON, JSONL](#files-and-formats) · [Lane](#context-and-request-lanes) · [Leg](#comparison-set-leg-and-round) · [Manifest](#files-and-formats) · [Median](#median-n-and-range) · [Minimal](#context-and-request-lanes) · [Model time, Muse](#time-measurements) |
| N–R | [n](#median-n-and-range) · [Needs approval, not checked](#execution-and-task-status) · [One-shot](#run-session-and-turn) · [Out, output speed](#calls-and-tokens) · [Overhead](#time-measurements) · [Partial trace](#context-and-request-lanes) · [Passed](#execution-and-task-status) · [Prompt](#run-session-and-turn) · [Provider](#agent-harness-provider-and-model) · [Race, round](#comparison-set-leg-and-round) · [Range](#median-n-and-range) · [Reasoning tokens](#calls-and-tokens) · [Replay](#replay-clock) · [Retries](#time-measurements) · [Run ID](#run-session-and-turn) |
| S–X | [Scope](#scope-and-totals) · [Session](#run-session-and-turn) · [Stalled](#time-measurements) · [State, suite](#files-and-formats) · [Status](#execution-and-task-status) · [Step, turn](#run-session-and-turn) · [Timeout](#execution-and-task-status) · [Token](#calls-and-tokens) · [Tools, TTFT](#time-measurements) · [USD](#cost-and-allowance) · [Usual, version change](#usual-fastest-and-change) · [Wall, wire time](#time-measurements) · [Window](#cost-and-allowance) · [Workspace](#files-and-formats) · [X-ray](#context-and-request-lanes) |

## Agent, harness, provider and model

An **agent** can use tools to carry out a prompt. Its **harness** is the software that prepares requests, runs tools and manages the interaction. **Version** is the recorded version of this software. The **model** generates responses. A **CLI** (command-line interface) is a program you run in a terminal. An **API** (application programming interface) lets software send a request directly to a service. [Choose a provider and model](user-guide.md#choose-a-provider-and-model)

**Provider/Model** identifies the route and model in a result. For example, `claude-code/muse-wonder-1.0` uses Claude Code as the harness with Meta as the model service. **Requested model** is the ID supplied to the runner. The report uses the model reported in usage data when available and otherwise falls back to the requested ID, with echo recorded as echo. A saved ID alone cannot verify which weights a service ran. [Provider table](user-guide.md#choose-a-provider-and-model)

## Run, session and turn

A **prompt** is the instruction you submit. **One-shot** means it contains the whole task in one submission. A **run** is one benchmark attempt with its own local **run ID**. A **session ID** identifies the harness conversation or log. One interactive session can produce several benchmark runs, one for each eligible **turn** (a submitted prompt and the agent's activity in response). A **step** is a recorded event, such as a tool starting or a model response arriving. A turn can contain several calls and many steps. [Record and inspect a run](user-guide.md#record-and-inspect-your-first-run) · [Import interactive turns](user-guide.md#use-the-terminal)

## Execution and task status

| Label | Meaning |
|---|---|
| Running | The launcher registered the attempt. Available counters may still change. |
| Completed | The runner recorded successful execution. Imported turns require a recorded outcome. Read the task chip and inspect the actual answer. |
| Failed | Execution ended unsuccessfully, for example with a nonzero exit or a Codex turn error. Read the report's error field and stderr if available. |
| Timeout | The runner reached a time limit and stopped the agent. A transport error on a direct API request can instead appear as failed. |
| Interrupted | The run was stopped, for example with Ctrl+C. The server can also display this for an old running entry with no final report after its timeout and grace period. |
| Needs approval (`needs_approval`) | The watcher detected an operation waiting for approval and stopped the run. The requested tool can appear in the report. |
| Unknown | The log did not establish an interactive turn's outcome. It is excluded from completed-run medians. |
| Task: passed / failed / not checked | All configured checks passed, at least one failed, or checks were absent or execution did not complete. Older records can lack checks. The checks test only the stated conditions. |

A **check** tests a literal reply substring or verifies that a named file exists inside the workspace. For example, a reply containing “the answer is 40” also contains the substring “answer is 4”. A passed substring check can therefore miss an incorrect answer. [Run a suite and check the work](user-guide.md#run-a-suite-and-check-the-work)

## Time measurements

Stored durations are usually in milliseconds (**ms**). One second (**s**) is 1,000 ms. A dash means the display has no usable value for that measurement. A recorded zero is possible. The categories below refer to one run unless a chart explicitly says median or total. [Overview](user-guide.md#overview) · [Timeline](user-guide.md#timeline)

| Label | How to read it |
|---|---|
| Wall time / Wall | Elapsed time around the launched process, including waiting. On the direct API path it times the HTTP exchange. For imported turns it runs from accepted prompt to last recorded activity. Setup and task validation can sit outside this interval. |
| Elapsed | While running, time since the recorded start. The final Wall value comes from the runner's measured interval. |
| Model time / Model | Sum of call durations when all are available. Claude Code contributes reported whole-run API time. The direct API uses request elapsed time. Codex provides neither measure. An imported call starting before the turn, or an imported total exceeding its wall, can invalidate the total. Includes waiting visible to the harness. |
| Model time, last call / wire time / wire_ms | Duration supplied for that model request. The direct API path measures it locally. “Slowest call” is the largest available call duration. Neither measures network transit alone. A run total cannot recover a missing per-call duration. |
| Tools | Time covered by closed Muse tool intervals, merging overlaps and subtracting overlapping closed approval waits. No tool events in an available trace can yield zero. An unmatched start can leave the bucket unknown. |
| Approval wait | Time covered by paired approval start/end events. Overlapping waits count once. An unclosed wait leaves the approval total unknown. A tool waiting for approval may span both kinds of event. |
| Muse | Remaining wall time after subtracting Model, Tools and Approval wait. Missing buckets, overlapping model activity or a negative remainder can make the split unusable. This residual does not identify individual internal operations. |
| Overhead | In run rows, wall minus model, bounded below by zero. It includes tools, approval waits and other elapsed time outside the model total. Unknown if either input is absent. |
| % of wall | Bucket time divided by nonzero wall time, times 100, rounded to whole percent. “Why was this slow” ranks recorded slices and flags patterns such as a long retry or a dominant call. These are observations about that trace. |
| Time until next step | Next event timestamp minus the current timestamp, or the gap between stream arrivals for Claude Code. A final event can have no next-step value. Events may occur while several operations are active. |
| TTFT | Time to first token, in ms. The benchmark uses a reported Claude Code result field when available. A missing TTFT cannot be reconstructed from the first displayed line. |
| Retries / stalled | Retries count recorded repeat attempts attached to a call. Stalled ms is the time from the first attempt opening to the final attempt opening, minus the announced retry delays. It needs at least two recorded openings and is already included in model duration. |
| Tool calls / slowest tool | Named tool details group closed intervals by name. Total time sums their durations, slowest is the longest single interval, and wait sums the approval time inside them. Parallel calls can overlap, so these totals can differ from the merged Tools card. |

## Calls and tokens

A **model call** is one request to the model. **Calls** counts the call records the harness exposed. A zero on a non-Codex row can mean no call records were available. Codex leaves the count unknown. A **token** is a unit of model input or output. Its size in characters or bytes varies. [Timeline](user-guide.md#timeline) · [Compare](user-guide.md#compare)

| Label | Source, unit and interpretation |
|---|---|
| Input tokens / In | Recorded tokens sent as input. A run uses reported totals when present, otherwise a complete sum across calls. Repeated context can count again on later calls. For Claude Code and direct API, comparable input includes fresh input, cache creation and cache reads. Missing components can make the total unknown, including in older direct API records. |
| Cached / cache read / cache creation | Cache read counts input tokens served from an existing cache. Cache creation counts input tokens used to populate it. Codex input already includes cached input. On Overview, “% cached” is 100 × summed cached tokens / summed input, rounded. Every call needs both fields and total input must be positive. [Anthropic Messages usage fields](https://platform.claude.com/docs/en/api/messages/create) |
| Output tokens / Out | Recorded tokens generated. Counts describe provider usage and can include more than the visible reply. Run totals and last-call counts answer different questions. Claude Code can supply a run output total with no usable last-call output count. |
| Reasoning tokens | A provider-reported count associated with reasoning, when supplied. Some data is available in machine-readable records only. Treat it as a reported usage category. Adding it to output can double count. |
| Output speed / Out speed | Output tokens divided by model time in seconds, in tokens/s. Requires recorded output and positive model time. For illustration, 80 output tokens over 2 model seconds gives 40 tokens/s. It includes waits within model time. |
| Last call / run | “Input, last call” and “Output, last call” refer to the latest recorded request. Run values cover the whole attempt. A missing entry in a required call sum makes that total unavailable. |

## Context and request lanes

**Context** is the information supplied to the model along with the current task. **Full** uses the harness's ordinary context. **Minimal** selects the runner's provider-specific reductions. **Bare** is the Claude Code mode used here. **Interactive** labels imported Muse work. The mode label alone cannot tell you how many tokens or bytes were sent. [Choose a provider](user-guide.md#choose-a-provider-and-model)

**X-ray** uses recorded Muse input traces. A **lane** groups related parts of the request. Labels include **System prompt**, **Run context**, **Conversation so far**, **Tool results**, **Tool definitions** and **Provider options**. Groups with the same lane name are summed in bytes. **Calls traced** counts available traces. **Your prompt, call 1** uses the recorded user-byte count. Its percentage is 100 × user bytes / first request total bytes when both are usable and the total is positive. Segment widths show the lane's share of the request. Overall bar length scales with total bytes across calls. Omitted groups or bytes make a trace **partial**. A zero-byte group remains recorded even if invisible in a bar. An absent lane can have an unknown value. [Read X-ray](user-guide.md#x-ray)

## Replay clock

**Offset** is elapsed time from the first timestamped step. **Span** runs to the last timestamped step. A call **lands** when its recorded completion is reached. Its **in-flight** interval extends back from completion by its recorded duration. At a playhead position, **calls landed** counts completions reached. Model and token totals sum landed calls only when each supplies the relevant field. In paired replay, **start gap** is the second trace's first timestamp minus the first trace's first timestamp. It requires both. Playback speed multiplies how fast the playhead advances. [Use Replay](user-guide.md#replay)

## Cost and allowance

**USD** means US dollars. **MTok** means one million tokens. The **Cost** cell uses the unit supported by the provider. A missing cost cannot establish that a run was free. [Choose a provider and model](user-guide.md#choose-a-provider-and-model)

| Label | How it is calculated |
|---|---|
| Reported | A usable dollar figure returned by the harness. Claude Code's reported figure for a Claude model is retained when present. Its reported price for a Muse model is hidden because it uses a different provider's price list. |
| At Meta list | The runner's standard Wonder snapshot dated 2026-10-31 uses USD per million tokens: 4 for input outside cache reads, 0.20 for cached reads and 20 for output. On a current record with complete totals, multiply each count by its rate, add, and divide by one million. This snapshot covers one model on paid routes. [Meta pricing](https://dev.meta.ai/docs/pricing-rate-limits) |
| At your rates | Computed from recorded usage and configured rates in BENCH_PRICING or manifest settings. With direct API totals, subtract cache reads/writes from total input, price each positive cache component separately, add fresh input and output charges, then divide by one million. Other custom calculations use input and output totals at their respective rates. On direct API totals, a cache count the API did not report counts as zero only when you set that cache rate. A cache count above zero with no rate for it leaves the cost unknown. A missing input or output count does too. Eligible Wonder records can fall back to the pinned list. [Configuration](../README.md#configuration) · [Claude API prices](https://platform.claude.com/docs/en/about-claude/pricing) |
| Plan usage / allowance | Muse compares whole-percent readings for two limits, short-term (**Window**) and weekly. For each, subtract the pre-run percentage from the end percentage. A move from 12% to 14% means two percentage points. Concurrent use of the same account can contribute. |
| Under 1% / reset | Equal readings in the same window display as under 1%. The readings cannot distinguish zero usage from a smaller movement. A missing reading, changed reset timestamp or lower end percentage leaves that window's change unknown. Reset time is the recorded time when the limit renews. |
| Codex cost / billing mode | The saved mode can be subscription, API or unknown according to recognizable CLI login status. It stays in the report and index. The dashboard shows no dollar cost for Codex. Consult the service for account charges. [Codex authentication](https://learn.chatgpt.com/docs/auth) · [OpenAI API pricing](https://developers.openai.com/api/docs/pricing/) |

## Comparison set, leg and round

A **comparison set** links runs launched together for one prompt through a shared comparison ID. A **leg** is a provider/model pair. A **round** is one attempt per leg. **Repeat** controls the number of rounds. **Race** starts the round's legs concurrently. **Mode** in Runs shows the compare preset or single. It differs from context mode. A suite has a suite ID and entry names and can also repeat tasks. [Repeat and compare](user-guide.md#repeat-and-compare)

## Median, n and range

A **median** is the middle value after sorting. For an even number of observations, average the middle two. **n** counts usable observations for that metric. **Range** is the smallest through the largest observed value. The medians table uses completed runs, even when a configured task check failed. Missing metric values drop out only for that metric. For illustration, wall times of 2, 3 and 12 seconds have median 3 s, range 2–12 s, n=3. If only two recorded output speeds, speed has n=2. **Completed/total** counts processes and includes all attempts in the denominator. [Read Compare](user-guide.md#compare)

## Usual, fastest and change

| Label | Matching and arithmetic |
|---|---|
| Usual | Median of earlier completed runs matching exact prompt text, provider, model and context. Needs three matching runs. Each metric uses available observations. Harness version is outside the match criteria. [Overview](user-guide.md#overview) |
| Fastest completed / × faster | Compare positive median wall times for at least two eligible groups. Each needs at least three recorded wall times on completed runs. The fastest group's maximum must be strictly below every other eligible group's minimum. The ratio is slowest median / fastest median. Missing medians fall outside the comparison. The badge says nothing about task checks. [Compare](user-guide.md#compare) |
| Difference / delta | For individual picks, subtract the other run's value from the first run's value. Time and cost favour lower values, output speed favours higher. Missing sides have no numeric delta. Two plan-usage runs can show the short-term difference in points. A dollar amount and an allowance cannot be subtracted. [Compare](user-guide.md#compare) |
| Version change | Radar groups completed runs by prompt, provider, model and context. It orders versions by first observed date and compares the latest two with at least three wall measurements each. Change is newer median minus older median. Percent change divides that difference by the older median and multiplies by 100. A zero older median has no percentage. Model time and input each need three usable values per version for their own change. Unknown versions can have their own column. [Radar](user-guide.md#radar) |

## Scope and totals

**Scope** names the group behind Overview's recent-run chart and provider/model medians. Normally this is the selected comparison set or matching exact prompt. Shared filters can instead select rows across history. The selected run's cards still describe that run. **Copy summary** in Runs covers all sessions. Wall, model and USD totals sum the available values and report how many runs supplied them. Summary overhead requires both times on every included run. Plan totals sum recorded movements separately per window and exclude raced runs to reduce double counting. [Overview](user-guide.md#overview) · [Runs](user-guide.md#runs)

## Files and formats

| Term | Meaning |
|---|---|
| Workspace | Per-run directory where an agent works. It can contain useful output even when execution stops early. [Find files](user-guide.md#find-files-and-remove-a-run) |
| JSON / report | JavaScript Object Notation, a structured text format. The report is one JSON object for a run. Its fields may hold null for unavailable values. [Inspect a report](user-guide.md#record-and-inspect-your-first-run) |
| JSONL / index / events | JSON Lines, one JSON record per line. The index collects running and final summaries. Events capture provider output when available. stderr.log contains the process's diagnostic output. [Find files](user-guide.md#find-files-and-remove-a-run) |
| CSV / export | Comma-separated values. The dashboard CSV represents selected call rows. The JSON export contains the loaded dashboard data. A run card and repro pack are Markdown summaries with different levels of detail. [Export](user-guide.md#export) |
| Manifest / suite / state | A manifest defines tasks, settings and checks. A suite executes the tasks. The optional state file stores progress by entry name and round beside the manifest for resume. [Run a suite](user-guide.md#run-a-suite-and-check-the-work) |
