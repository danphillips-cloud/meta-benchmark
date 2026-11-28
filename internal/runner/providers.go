package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"meta-benchmark/internal/report"
	"meta-benchmark/internal/streams"
)

// Injectable process lookups so tests never execute a real
// provider binary.
var (
	lookPath = exec.LookPath
	isWSLNow = func() bool { return IsWSL(os.Getenv, readOSRelease()) }
)

// EndpointFor picks the direct API endpoint and key by model.
// muse-* goes to Meta's Anthropic-compatible API, anything
// else goes to Anthropic.
func EndpointFor(model string) (base, apiKey string) {
	if strings.HasPrefix(model, "muse-") {
		return strings.TrimRight(envOr("META_BASE_URL", "https://api.meta.ai"), "/"),
			os.Getenv("MODEL_API_KEY")
	}
	return strings.TrimRight(envOr("ANTHROPIC_BASE_URL", "https://api.anthropic.com"), "/"),
		os.Getenv("ANTHROPIC_API_KEY")
}

// guardProviderBinary resolves a provider binary and refuses
// a Windows binary reached through WSL PATH interop. Such a
// binary would write session logs where the reader never
// looks, which used to fail as silent missing metrics. An
// empty message means the binary may run. A missing binary is
// left to each provider's existing not-installed handling.
func guardProviderBinary(name string) string {
	path, err := lookPath(name)
	if err != nil || !isWSLNow() {
		return ""
	}
	if strings.HasPrefix(path, "/mnt/") || strings.HasSuffix(strings.ToLower(path), ".exe") {
		return fmt.Sprintf("%s resolved to a Windows binary at %s. Install the Linux build inside WSL and try again.", name, path)
	}
	return ""
}

func envWith(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if !strings.HasPrefix(kv, prefix) {
			out = append(out, kv)
		}
	}
	return append(out, prefix+value)
}

func intPtrFromAny(v any) *int64 {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return &i
		}
		if f, err := n.Float64(); err == nil && f == float64(int64(f)) {
			i := int64(f)
			return &i
		}
	case float64:
		i := int64(n)
		if float64(i) == n {
			return &i
		}
	}
	return nil
}

// RunAnthropic makes one direct Messages API call. No agent
// context. It mirrors run-muse run_anthropic.
func RunAnthropic(ctx context.Context, prompt, runDir, model string, timeoutSeconds int) Result {
	base, apiKey := EndpointFor(model)
	command := "POST " + base + "/v1/messages"
	if apiKey == "" {
		result := emptyResult(command)
		msg := endpointKeyName(model) + " is not set"
		result.ErrorOverride = &msg
		return result
	}
	maxTokens := 8192
	if raw := os.Getenv("ANTHROPIC_MAX_TOKENS"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			maxTokens = parsed
		}
	}
	body, _ := json.Marshal(map[string]any{
		"model": model, "max_tokens": maxTokens,
		"messages": []map[string]any{{"role": "user", "content": prompt}},
	})
	reqCtx := ctx
	var cancel context.CancelFunc
	if timeoutSeconds > 0 {
		reqCtx, cancel = context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost,
		base+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		result := emptyResult(command)
		msg := err.Error()
		result.ErrorOverride = &msg
		return result
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	started := time.Now()
	var data map[string]any
	exitCode := 0
	var errorText *string
	resp, doErr := http.DefaultClient.Do(req)
	switch {
	case doErr != nil && ctx.Err() != nil:
		// Ctrl+C during the direct call records an interrupted
		// run with exit 130, like the Python exception path.
		return Result{WallMS: pyRoundMS(time.Since(started)), ExitCode: 130,
			Interrupted: true, Calls: []report.Call{}}
	case doErr != nil:
		exitCode = 1
		msg := doErr.Error()
		errorText = &msg
		data = map[string]any{}
	default:
		raw, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode >= 400 {
			exitCode = resp.StatusCode
			data = map[string]any{}
			msg := fmt.Sprintf("HTTP %d", resp.StatusCode)
			var payload map[string]any
			if json.Unmarshal(raw, &payload) == nil {
				if errObj, ok := payload["error"].(map[string]any); ok {
					if m, ok := errObj["message"].(string); ok && m != "" {
						msg = m
					}
				}
			}
			errorText = &msg
		} else {
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.UseNumber()
			if err := dec.Decode(&data); err != nil || data == nil {
				data = map[string]any{}
				exitCode = 1
				msg := "response was not valid JSON"
				if err != nil {
					msg = err.Error()
				}
				errorText = &msg
			}
		}
	}
	wallMS := pyRoundMS(time.Since(started))
	usage, _ := data["usage"].(map[string]any)
	usageNums := map[string]any{}
	for k, v := range usage {
		usageNums[k] = v
	}
	reply := ""
	if content, ok := data["content"].([]any); ok {
		for _, item := range content {
			block, ok := item.(map[string]any)
			if ok && block["type"] == "text" {
				if text, ok := block["text"].(string); ok {
					reply += text
				}
			}
		}
	}
	inputWithCache := streams.InputWithCache(usageNums)
	var calls []report.Call
	var timeline []report.TimelineRow
	if len(data) > 0 {
		callModel, _ := data["model"].(string)
		if callModel == "" {
			callModel = model
		}
		wall := float64(wallMS)
		_, hasCreation := usage["cache_creation_input_tokens"]
		calls = []report.Call{{
			Model: &callModel, DurationMS: &wall, InputTokens: inputWithCache,
			FreshInputTokens:     intPtrFromAny(usage["input_tokens"]),
			CacheCreationTokens:  intPtrFromAny(usage["cache_creation_input_tokens"]),
			CacheCreationPresent: hasCreation,
			OutputTokens:         intPtrFromAny(usage["output_tokens"]),
			CachedTokens:         intPtrFromAny(usage["cache_read_input_tokens"]),
			StopReason:           strPtrValue(data["stop_reason"]),
		}}
		at := isoTime(time.Now())
		timeline = []report.TimelineRow{{At: &at, Operation: "model_completed", WireMS: &wall}}
	}
	if calls == nil {
		calls = []report.Call{}
	}
	if timeline == nil {
		timeline = []report.TimelineRow{}
	}
	_ = os.WriteFile(filepath.Join(runDir, "events.jsonl"), nil, 0o644)
	errText := ""
	if errorText != nil {
		errText = *errorText
	}
	_ = os.WriteFile(filepath.Join(runDir, "stderr.log"), []byte(errText), 0o644)
	_, hasCreation := usage["cache_creation_input_tokens"]
	return Result{
		WallMS: wallMS, ExitCode: exitCode, Reply: reply,
		Calls: calls, Timeline: timeline, Command: &command,
		UsageModel: strPtrValue(data["model"]), ErrorOverride: errorText,
		Totals: &Totals{
			Input: inputWithCache, CacheCreation: intPtrFromAny(usage["cache_creation_input_tokens"]),
			HasCacheCreation: hasCreation,
			Output:           intPtrFromAny(usage["output_tokens"]),
			Cached:           intPtrFromAny(usage["cache_read_input_tokens"])},
	}
}

func strPtrValue(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

// --- Claude Code ---

// FormatClaudeCallLine times a landed call by arrival. Claude
// Code reports no per-call duration, so it never claims model time.
func FormatClaudeCallLine(n int, gapMS, inputTokens *int64) string {
	gap := "–"
	if gapMS != nil {
		gap = fmt.Sprintf("+%.1f s", float64(*gapMS)/1000)
	}
	tok := "– in"
	if inputTokens != nil {
		tok = fmt.Sprintf("%dk in", int64(math.RoundToEven(float64(*inputTokens)/1000)))
	}
	return fmt.Sprintf("call %d · arrived %s · %s", n, gap, tok)
}

func formatStreamLiveLine(state streams.State) string {
	switch state.State {
	case "waiting for approval":
		if state.Tool != nil && *state.Tool != "" {
			return "waiting for approval: " + *state.Tool
		}
		return "waiting for approval"
	case "tool running":
		if state.Tool != nil && *state.Tool != "" {
			return "tool running: " + *state.Tool
		}
		return "tool running"
	}
	if state.State == "" {
		return "idle"
	}
	return state.State
}

type claudeSeen struct {
	index       int
	tracker     *streams.Tracker
	live        string
	lastArrival *int64
}

func claudeLiveWatch(sink *lineSink, seen *claudeSeen, label string, out io.Writer) *Verdict {
	prefix := ""
	if label != "" {
		prefix = label + " · "
	}
	lines := sink.snapshot()
	for seen.index < len(lines) {
		stamped := lines[seen.index]
		seen.index++
		dec := json.NewDecoder(bytes.NewReader([]byte(stamped.Line)))
		dec.UseNumber()
		var event map[string]any
		if err := dec.Decode(&event); err != nil {
			continue
		}
		arrival := stamped.ArrivalMS
		var gap *int64
		if seen.lastArrival != nil {
			g := arrival - *seen.lastArrival
			gap = &g
		} else {
			g := arrival
			gap = &g
		}
		seen.lastArrival = &arrival
		if call, fresh := seen.tracker.FeedLiveEvent(event); fresh {
			printMu.Lock()
			if label == "" && isTTY(out) && seen.live != "" {
				clearLiveLine(out, seen.live)
			}
			fmt.Fprintln(out, prefix+FormatClaudeCallLine(
				len(seen.tracker.Calls()), gap, call.InputTokens))
			printMu.Unlock()
		}
		text := formatStreamLiveLine(seen.tracker.LiveState())
		if text != seen.live {
			printMu.Lock()
			switch {
			case text == "ended":
				if label == "" && isTTY(out) && seen.live != "" {
					clearLiveLine(out, seen.live)
				}
			case label != "" || !isTTY(out):
				fmt.Fprintln(out, prefix+text)
			default:
				fmt.Fprint(out, "\r"+text+"   ")
			}
			printMu.Unlock()
			seen.live = text
		}
	}
	return nil
}

// RunClaudeCode runs one prompt through Claude Code --bare.
func RunClaudeCode(ctx context.Context, prompt, runDir, model string,
	timeoutSeconds int, legLabel string, out io.Writer) Result {
	workspace := filepath.Join(runDir, "workspace")
	_ = os.MkdirAll(workspace, 0o755)
	_ = os.WriteFile(filepath.Join(runDir, "prompt.md"), []byte(prompt), 0o644)
	argv := []string{"claude", "-p", "--bare", "--output-format", "stream-json",
		"--verbose", "--model", model, "--permission-mode", "dontAsk",
		"--allowedTools", "Bash,Edit,Read"}
	command := strings.Join(argv, " ")
	base, apiKey := EndpointFor(model)
	if apiKey == "" {
		result := emptyResult(command)
		msg := endpointKeyName(model) + " is not set"
		result.ErrorOverride = &msg
		return result
	}
	if guard := guardProviderBinary("claude"); guard != "" {
		result := emptyResult(command)
		result.ErrorOverride = &guard
		return result
	}
	env := CleanEnv()
	env = envWith(env, "ANTHROPIC_API_KEY", apiKey)
	env = envWith(env, "ANTHROPIC_BASE_URL", base)
	env = envWith(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL", model)
	env = envWith(env, "ANTHROPIC_DEFAULT_SONNET_MODEL", model)
	env = envWith(env, "ANTHROPIC_DEFAULT_OPUS_MODEL", model)
	sink := &lineSink{}
	seen := &claudeSeen{tracker: streams.NewLiveTracker()}
	watch := func() *Verdict { return claudeLiveWatch(sink, seen, legLabel, out) }
	proc, err := RunProcess(ctx, argv, workspace, env,
		filepath.Join(runDir, "events.jsonl"), timeoutSeconds, &prompt, watch, sink)
	if err != nil {
		result := emptyResult(command)
		msg := err.Error()
		result.ErrorOverride = &msg
		return result
	}
	_ = watch()
	if isTTY(out) && legLabel == "" && seen.live != "" && seen.live != "ended" {
		clearLiveLine(out, seen.live)
	}
	stamped := make([]streams.Stamped, 0, len(proc.Lines))
	for _, l := range proc.Lines {
		at := float64(l.ArrivalMS)
		stamped = append(stamped, streams.Stamped{ArrivalMS: &at, Line: l.Line})
	}
	parsed := streams.ParseClaudeStream(stamped)
	exitCode := proc.ExitCode
	var errorText *string
	if parsed.IsError {
		if exitCode == 0 {
			exitCode = 1
		}
		msg := parsed.Reply
		if msg == "" {
			if parsed.APIErrorStatus != nil {
				msg = fmt.Sprintf("api_error_status %v", parsed.APIErrorStatus)
			} else {
				msg = "Claude Code reported an error"
			}
		}
		errorText = &msg
	}
	calls := make([]report.Call, 0, len(parsed.Calls))
	for _, c := range parsed.Calls {
		calls = append(calls, report.Call{
			Model: c.Model, DurationMS: c.DurationMS, InputTokens: c.InputTokens,
			OutputTokens: c.OutputTokens, CachedTokens: c.CachedTokens,
			ReasoningTokens: c.ReasoningTokens})
	}
	timeline := make([]report.TimelineRow, 0, len(parsed.Timeline))
	for _, row := range parsed.Timeline {
		timeline = append(timeline, report.TimelineRow{
			At: row.At, Operation: row.Operation,
			DurationMS: row.DurationMS, WireMS: row.WireMS})
	}
	result := Result{
		SessionID: parsed.SessionID, WallMS: proc.WallMS, ExitCode: exitCode,
		TimedOut: proc.TimedOut, Interrupted: proc.Interrupted, Reply: parsed.Reply,
		Calls: calls, Timeline: timeline, Command: &command,
		UsageModel: parsed.UsageModel, ErrorOverride: errorText,
		APIMS: parsed.APIMS, TTFTMS: parsed.TTFTMS, NumTurns: parsed.NumTurns,
		CostUSD: parsed.CostUSD,
	}
	if parsed.Totals != nil {
		result.Totals = &Totals{
			Input: parsed.Totals.InputTokens, Output: parsed.Totals.OutputTokens,
			Cached: parsed.Totals.CachedTokens}
	}
	return result
}

// --- Codex ---

var codexMinimalConfig = []string{
	"project_doc_max_bytes=0", `developer_instructions=""`,
	"memories.use_memories=false", "memories.generate_memories=false",
	"features.memories=false", "skills.include_instructions=false",
	"features.skill_search=false", "features.apps=false",
	"features.hooks=false", "features.plugins=false",
	"features.remote_plugin=false", "mcp_servers={}", `web_search="disabled"`,
}

var (
	codexChatGPTRe  = regexp.MustCompile(`^Logged in using ChatGPT\b`)
	normalizeSpaces = regexp.MustCompile(`\s+`)
)

// CodexBillingMode classifies CLI login status without
// storing account or key text.
func CodexBillingMode(env []string) string {
	return codexBillingModeWith(func() ([]byte, []byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "codex", "login", "status")
		cmd.Env = env
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
		return stdout.Bytes(), stderr.Bytes(), err
	})
}

func codexBillingModeWith(run func() ([]byte, []byte, error)) string {
	stdout, stderr, err := run()
	if err != nil {
		return "unknown"
	}
	for _, line := range strings.Split(string(stdout)+"\n"+string(stderr), "\n") {
		normalized := strings.TrimSpace(normalizeSpaces.ReplaceAllString(line, " "))
		if codexChatGPTRe.MatchString(normalized) {
			return "subscription"
		}
		if normalized == "Logged in using an API key" ||
			strings.HasPrefix(normalized, "Logged in using an API key - ") {
			return "api"
		}
	}
	return "unknown"
}

// RunCodex runs one fresh Codex agent session. It uses the
// existing CLI login and never copies keys or changes login.
func RunCodex(ctx context.Context, prompt, runDir, model string,
	minimal bool, timeoutSeconds int, out io.Writer) Result {
	argv := []string{"codex", "-a", "never", "exec", "--json", "--ephemeral",
		"--sandbox", "workspace-write", "--skip-git-repo-check", "--color", "never"}
	baseCommand := strings.Join(argv, " ")
	if model == "" {
		result := emptyResult(baseCommand)
		msg := "Codex requires --model or BENCH_CODEX_MODEL"
		result.ErrorOverride = &msg
		return result
	}
	if _, err := lookPath("codex"); err != nil {
		result := emptyResult(baseCommand)
		msg := "codex CLI is not installed"
		result.ErrorOverride = &msg
		return result
	}
	if guard := guardProviderBinary("codex"); guard != "" {
		result := emptyResult(baseCommand)
		result.ErrorOverride = &guard
		return result
	}
	argv = append(argv, "--model", model, "-c", `model_provider="openai"`)
	if minimal {
		argv = append(argv, "--ignore-user-config", "--strict-config")
		for _, setting := range codexMinimalConfig {
			argv = append(argv, "-c", setting)
		}
	}
	argv = append(argv, "-")
	command := strings.Join(argv, " ")
	workspace := filepath.Join(runDir, "workspace")
	_ = os.MkdirAll(workspace, 0o755)
	_ = os.WriteFile(filepath.Join(runDir, "prompt.md"), []byte(prompt), 0o644)
	env := CleanEnv()
	billing := CodexBillingMode(env)
	proc, err := RunProcess(ctx, argv, workspace, env,
		filepath.Join(runDir, "events.jsonl"), timeoutSeconds, &prompt, nil, nil)
	if err != nil {
		result := emptyResult(command)
		msg := err.Error()
		result.ErrorOverride = &msg
		result.BillingMode = &billing
		return result
	}
	stamped := make([]streams.Stamped, 0, len(proc.Lines))
	for _, l := range proc.Lines {
		at := float64(l.ArrivalMS)
		stamped = append(stamped, streams.Stamped{ArrivalMS: &at, Line: l.Line})
	}
	parsed := streams.ParseCodexStream(stamped)
	result := emptyResult(command)
	result.SessionID = parsed.SessionID
	result.Reply = parsed.Reply
	result.ErrorOverride = parsed.ErrorOverride
	if parsed.Totals != nil {
		result.Totals = &Totals{
			Input: parsed.Totals.InputTokens, Cached: parsed.Totals.CachedTokens,
			Output: parsed.Totals.OutputTokens, Reasoning: parsed.Totals.ReasoningTokens}
	}
	result.WallMS = proc.WallMS
	result.ExitCode = proc.ExitCode
	result.TimedOut = proc.TimedOut
	result.Interrupted = proc.Interrupted
	result.BillingMode = &billing
	if !parsed.Completed && result.ErrorOverride == nil {
		msg := "Codex stream ended without turn.completed"
		if data, readErr := os.ReadFile(filepath.Join(runDir, "stderr.log")); readErr == nil {
			if trimmed := strings.TrimSpace(string(data)); trimmed != "" {
				lines := strings.Split(trimmed, "\n")
				msg = lines[len(lines)-1]
			}
		}
		result.ErrorOverride = &msg
	}
	if !parsed.Completed && result.ExitCode == 0 {
		result.ExitCode = 1
	}
	return result
}
