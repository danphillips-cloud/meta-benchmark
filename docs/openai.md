# Compare Meta, OpenAI and Claude

I use Codex CLI for the OpenAI leg because these prompts ask an agent to write files and run code. Muse, Codex and Claude Code each get the same prompt in their own workspace. The result compares the whole agent, including its model, tools and context.

## Sign in and run

The `codex` command must be on your shell's PATH. Check with `command -v codex`, then sign in:

```sh
codex login
codex login status
```

ChatGPT login uses subscription access. For API-key billing, establish a CLI login with the key instead:

```sh
printenv OPENAI_API_KEY | codex login --with-api-key
```

The benchmark removes `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` from Codex's environment. An exported key alone will not work. Both commands above establish a login that the CLI can reuse. The benchmark does not change it.

Choose an OpenAI model available to that account. There is no default:

```sh
export BENCH_CODEX_MODEL="YOUR_OPENAI_MODEL_ID"
./run-muse --provider codex --model "$BENCH_CODEX_MODEL" --minimal "Reply with exactly: pong"
```

The benchmark prints a usage notice and starts the run. It does not ask for confirmation. The default timeout is 300 seconds. Change it with `--timeout`. Interrupted and timed-out runs keep their events and partial files.

## Put all three on one prompt

```sh
PROMPT="Write primes.py in the current folder. Print the count of prime numbers below 100000. Run it and report the count."
COMPARE_MODELS="meta:muse-wonder-full-1.0,codex:$BENCH_CODEX_MODEL,claude-code:claude-sonnet-5-5" ./run-muse --minimal --compare custom --repeat 3 "$PROMPT"
```

Three legs and three rounds start nine runs. Claude Code uses an API key in this benchmark. Codex uses its saved login, which may be a subscription or an API key.

Even rounds reverse the order. Compare shows medians over completed runs and keeps failed runs visible. Add `--race` to run the legs together. Concurrent runs share the machine, which can affect wall time.

## Read the results

Codex records wall time, token totals when present, its reply, task checks and CLI version. The reply and totals appear when the run finishes. Raw events stay in `events.jsonl`.

Call count, model time, TTFT, the time split and cost show dashes. Timeline, Replay and X-ray have no per-call detail. Token totals do not establish how many model calls ran. Cached input is already included in total input and is not added again.

The saved `billing_mode` is in both `report.json` and `index.jsonl`, but stays off the page. An unrecognized login-status format records unknown. No dollar cost is inferred from the tokens.

## Check a task across providers

Save this as a manifest and replace `YOUR_OPENAI_MODEL_ID`:

```json
{
  "settings": {"repeat": 3},
  "prompts": [
    {
      "name": "meta-ping",
      "provider": "meta",
      "model": "muse-wonder-full-1.0",
      "prompt": "Reply with exactly: pong",
      "minimal": true,
      "checks": {"reply_contains": ["pong"]}
    },
    {
      "name": "openai-ping",
      "provider": "codex",
      "model": "YOUR_OPENAI_MODEL_ID",
      "prompt": "Reply with exactly: pong",
      "minimal": true,
      "checks": {"reply_contains": ["pong"]}
    },
    {
      "name": "claude-ping",
      "provider": "claude-code",
      "model": "claude-sonnet-5-5",
      "prompt": "Reply with exactly: pong",
      "minimal": true,
      "checks": {"reply_contains": ["pong"]}
    }
  ]
}
```

```sh
./run-muse --suite path/to/manifest.json
```

A suite needs an entry for each provider. It appears in Runs. Use `--compare` for a grouped Compare set. The two flags cannot be combined.

`--resume` skips completed entries whose checks passed. When changing models, use `--fresh` with `--resume`. These reply checks look for a substring. Passing them is not proof that generated code works.

Dry-run labels Codex entries `MAY BE PAID` without querying login. Its concurrency warning includes Codex because API-key logins can spend in parallel. A recorded-cost budget cannot cap Codex charges, since Codex cost is unknown.

## Context and CLI compatibility

Each run starts a fresh, ephemeral session in `muse-runs/<run id>/workspace/`. It pins the OpenAI provider and uses the workspace-write sandbox without approval prompts. Execpolicy rules stay in place.

Full mode uses normal Codex context discovery. The workspace is inside this benchmark's Git root, so this repo's `AGENTS.md` is expected to load alongside global guidance. Use `--minimal` for the stripped-context comparison. It ignores user config and applies these 13 overrides:

```toml
project_doc_max_bytes = 0
developer_instructions = ""
memories.use_memories = false
memories.generate_memories = false
features.memories = false
skills.include_instructions = false
features.skill_search = false
features.apps = false
features.hooks = false
features.plugins = false
features.remote_plugin = false
mcp_servers = {}
web_search = "disabled"
```

The settings target automatic instructions, memories, skills and integrations. Normal sandbox read permissions and administrator policies still apply. This does not make the three agents' built-in prompts identical.

The exact command, including `--strict-config`, ran successfully on `codex-cli 0.167.0-alpha.4.1`. Local help and the captured run establish compatibility with that alpha version. The public configuration reference does not document every option in the command. Unsupported options fail the run without a weaker fallback.

The real run on 2026-11-12 returned `pong`. Its stream is in `tests/fixtures/codex-exec-captured.jsonl`, with capture metadata alongside it. Only the thread ID was replaced. It verifies the successful turn and usage format, not live tool execution or every failure path.

See the official [execution guide](https://learn.chatgpt.com/docs/non-interactive-mode), [authentication guide](https://learn.chatgpt.com/docs/auth), [instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) for their documented behavior.
