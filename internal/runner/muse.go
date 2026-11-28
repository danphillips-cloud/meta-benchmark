package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"meta-benchmark/internal/muselog"
	"meta-benchmark/internal/pricing"
)

// Result holds the report fields one provider run produced,
// mirroring the result dicts in run-muse.
type Result struct {
	SessionID           *string
	WallMS              int64
	ExitCode            int
	TimedOut            bool
	Interrupted         bool
	Reply               string
	Calls               []muselog.Call
	Timeline            []muselog.TimelineRow
	Command             *string
	UsageModel          *string
	ErrorOverride       *string
	NeedsApproval       *string
	AllowanceEnd        *pricing.Allowance
	APIMS               *float64
	TTFTMS              *float64
	NumTurns            *int64
	CostUSD             *float64
	Totals              *pricing.Tokens
	TotalsCacheCreation *int64
	HasCacheCreation    bool
	BillingMode         *string
	ReasoningEffort     *string
}

func emptyResult(command string) Result {
	cmd := command
	return Result{WallMS: 0, ExitCode: 1, Command: &cmd, Calls: []muselog.Call{}}
}

// FormatCallLine renders one landed Muse call for the terminal.
func FormatCallLine(n int, call muselog.Call) string {
	secs := "–"
	if call.DurationMS != nil {
		secs = fmt.Sprintf("%.1f s", *call.DurationMS/1000)
	}
	tok := "– in"
	if call.InputTokens != nil {
		tok = fmt.Sprintf("%dk in", int64(math.RoundToEven(float64(*call.InputTokens)/1000)))
	}
	if call.Retries != 0 && call.StalledMS != nil {
		word := "retries"
		if call.Retries == 1 {
			word = "retry"
		}
		return fmt.Sprintf("call %d · %s (%d s stalled, %d %s) · %s",
			n, secs, int64(math.RoundToEven(float64(*call.StalledMS)/1000)), call.Retries, word, tok)
	}
	return fmt.Sprintf("call %d · %s · %s", n, secs, tok)
}

// FormatLiveLine renders one live state for the terminal.
func FormatLiveLine(state muselog.State) string {
	switch state.State {
	case "retrying connection":
		if state.Attempt != nil && *state.Attempt != "" {
			return "retrying connection (attempt " + *state.Attempt + ")"
		}
		return "retrying connection"
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

var printMu sync.Mutex

func isTTY(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

type liveSeen struct {
	calls      int
	live       string
	path       string
	version    [3]int64 // inode, size, mtimeNS stand-ins: size+mtime used
	hasVersion bool
	verdict    *Verdict
}

// liveWatch polls a Muse session log, printing finished calls
// and the live state, stopping the run on an approval wait.
func liveWatch(sessionID string, seen *liveSeen, label string, out io.Writer) *Verdict {
	path := seen.path
	if path == "" {
		found, ok := muselog.SessionLogPath(sessionID)
		if !ok {
			return nil
		}
		path = found
		seen.path = path
	}
	info, err := os.Stat(path)
	if err != nil {
		seen.path = ""
		seen.hasVersion = false
		return nil
	}
	version := [3]int64{0, info.Size(), info.ModTime().UnixNano()}
	if seen.hasVersion && seen.version == version {
		return seen.verdict
	}
	prefix := ""
	if label != "" {
		prefix = label + " · "
	}
	records := muselog.ReadRecords(path)
	calls := muselog.CallsFromRecords(records)
	for seen.calls < len(calls) {
		seen.calls++
		printMu.Lock()
		if label == "" && isTTY(out) && seen.live != "" {
			clearLiveLine(out, seen.live)
		}
		fmt.Fprintln(out, prefix+FormatCallLine(seen.calls, calls[seen.calls-1]))
		printMu.Unlock()
	}
	state := muselog.LiveState(records)
	if len(records) > 0 || info.Size() == 0 {
		seen.version = version
		seen.hasVersion = true
	}
	seen.verdict = nil
	if state.State == "waiting for approval" {
		seen.verdict = &Verdict{Tool: state.Tool}
		return seen.verdict
	}
	text := FormatLiveLine(state)
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
	return nil
}

func clearLiveLine(out io.Writer, live string) {
	fmt.Fprint(out, "\r"+strings.Repeat(" ", len([]rune(live))+3)+"\r")
}

// RunMuseExec runs one prompt through Muse and returns
// report fields. provider "echo" echoes with no model call.
func RunMuseExec(ctx context.Context, prompt, runDir, provider, model string,
	minimal bool, timeoutSeconds int, sessionID string, out io.Writer) Result {
	if sessionID == "" {
		sessionID = newUUID()
	}
	workspace := filepath.Join(runDir, "workspace")
	_ = os.MkdirAll(workspace, 0o755)
	promptFile := filepath.Join(runDir, "prompt.md")
	_ = os.WriteFile(promptFile, []byte(prompt), 0o644)
	argv := []string{"muse", "exec", "--json", "--provider", provider,
		"--prompt-file", promptFile, "--workspace", workspace,
		"--session-id", sessionID, "--approval-mode", "never"}
	if provider != "echo" {
		argv = append(argv, "--model", model)
	}
	if minimal {
		argv = append(argv, "--disable-reminders", "--no-foreign-personal-context")
	}
	command := strings.Join(argv, " ")
	seen := &liveSeen{}
	var watch WatchFunc
	if provider != "echo" {
		watch = func() *Verdict { return liveWatch(sessionID, seen, "", out) }
	}
	proc, err := RunProcess(ctx, argv, workspace, CleanEnv(),
		filepath.Join(runDir, "events.jsonl"), timeoutSeconds, nil, watch, nil)
	if err != nil {
		result := emptyResult(command)
		msg := err.Error()
		result.ErrorOverride = &msg
		result.SessionID = &sessionID
		return result
	}
	if isTTY(out) && seen.live != "" && seen.live != "ended" {
		clearLiveLine(out, seen.live)
	}
	reply := ""
	var usageModel *string
	var allowanceEnd *pricing.Allowance
	data, _ := os.ReadFile(filepath.Join(runDir, "events.jsonl"))
	for _, line := range strings.Split(string(data), "\n") {
		var event map[string]any
		if json.Unmarshal([]byte(line), &event) != nil {
			continue
		}
		payload, _ := event["payload"].(map[string]any)
		switch payload["kind"] {
		case "run_terminal":
			if text, ok := payload["text"].(string); ok && text != "" {
				reply = text
			}
		case "run_usage":
			if models, ok := payload["models"].([]any); ok && len(models) > 0 {
				if first, ok := models[0].(map[string]any); ok {
					if name, ok := first["model"].(string); ok && name != "" {
						usageModel = &name
					}
				}
			}
			if snapshot := pricing.Snapshot(payload["allowance"]); snapshot != nil {
				allowanceEnd = snapshot
			}
		}
	}
	var calls []muselog.Call
	if provider != "echo" {
		calls = muselog.HarvestCalls(sessionID)
		// Read the log even after a timeout or Ctrl+C so
		// finished calls are kept. Only wait for a late flush
		// when the run exited cleanly.
		if len(calls) == 0 && proc.ExitCode == 0 {
			for i := 0; i < 10; i++ {
				time.Sleep(500 * time.Millisecond)
				calls = muselog.HarvestCalls(sessionID)
				if len(calls) > 0 {
					break
				}
			}
		}
	}
	if calls == nil {
		calls = []muselog.Call{}
	}
	sid := sessionID
	return Result{
		SessionID: &sid, WallMS: proc.WallMS, ExitCode: proc.ExitCode,
		TimedOut: proc.TimedOut, Interrupted: proc.Interrupted,
		Reply: reply, Calls: calls,
		Timeline: muselog.BuildTimeline(sessionID, float64(proc.WallMS)),
		Command:  &command, UsageModel: usageModel,
		NeedsApproval: proc.NeedsApproval, AllowanceEnd: allowanceEnd,
	}
}
