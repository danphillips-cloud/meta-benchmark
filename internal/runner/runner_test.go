package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"meta-benchmark/internal/pricing"
	"meta-benchmark/internal/report"
)

func fakeResult(overrides Result) Result {
	sid := "fake-session"
	cmd := "fake command"
	base := Result{
		SessionID: &sid, WallMS: 1200, ExitCode: 0, Reply: "pong",
		Command: &cmd,
		Calls: []report.Call{{
			DurationMS: f64p(1000), InputTokens: i64(100),
			OutputTokens: i64(5), CachedTokens: i64(40)}},
		Timeline: []report.TimelineRow{{Operation: "step"}},
	}
	if overrides.Reply != "" {
		base.Reply = overrides.Reply
	}
	if overrides.ExitCode != 0 {
		base.ExitCode = overrides.ExitCode
	}
	if overrides.TimedOut || overrides.Interrupted {
		base.TimedOut, base.Interrupted = overrides.TimedOut, overrides.Interrupted
	}
	if overrides.NeedsApproval != nil {
		base.NeedsApproval = overrides.NeedsApproval
	}
	if overrides.Calls != nil {
		base.Calls = overrides.Calls
	}
	if overrides.WallMS != 0 {
		base.WallMS = overrides.WallMS
	}
	return base
}

func f64p(v float64) *float64 { return &v }

func newFakeRunner(t *testing.T, result Result) (*Runner, *bytes.Buffer) {
	t.Helper()
	// Keep session log lookups inside an empty temp tree.
	t.Setenv("MUSE_SESSIONS_DIR", t.TempDir())
	out := &bytes.Buffer{}
	r := New(t.TempDir())
	r.Out = out
	r.ErrOut = &bytes.Buffer{}
	r.MuseExec = func(ctx context.Context, prompt, runDir, provider, model string,
		minimal bool, timeoutSeconds int, sessionID, legLabel string, w io.Writer) Result {
		return result
	}
	r.ClaudeExec = func(ctx context.Context, prompt, runDir, model string,
		timeoutSeconds int, legLabel string, w io.Writer) Result {
		return result
	}
	r.AnthropicExec = func(ctx context.Context, prompt, runDir, model string,
		timeoutSeconds int) Result {
		return result
	}
	r.CodexExec = func(ctx context.Context, prompt, runDir, model string,
		minimal bool, timeoutSeconds int, w io.Writer) Result {
		return result
	}
	none := func() *pricing.Allowance { return nil }
	r.AllowanceStartFn = none
	r.HarnessVersionFn = func(string) *string { return nil }
	return r, out
}

func readIndex(t *testing.T, r *Runner) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(r.DataDir, "index.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, m)
	}
	return rows
}

func TestRunPromptRecordsRunningThenFinal(t *testing.T) {
	r, out := newFakeRunner(t, fakeResult(Result{}))
	// No real session log exists for the fake session, so the
	// split stays unknown rather than estimated.
	rep, err := r.RunPrompt(context.Background(), "say pong",
		Options{Provider: "meta", Model: "muse-wonder-full-1.0"})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Status == nil || *rep.Status != "completed" {
		t.Fatalf("status = %v", rep.Status)
	}
	if rep.At == nil || rep.FinishedAt == nil || *rep.At == *rep.FinishedAt && false {
		t.Fatalf("at/finished = %v %v", rep.At, rep.FinishedAt)
	}
	if rep.Model == nil || *rep.Model != "muse-wonder-full-1.0" {
		t.Errorf("model = %v", rep.Model)
	}
	if rep.MetricsUnavailable {
		t.Error("completed run with calls must record metrics as available")
	}
	if rep.TaskValidation == nil || rep.TaskValidation.Status != "not_checked" {
		t.Errorf("validation = %+v", rep.TaskValidation)
	}
	rows := readIndex(t, r)
	if len(rows) != 2 {
		t.Fatalf("index rows = %d, want running then final", len(rows))
	}
	if rows[0]["status"] != "running" || rows[0]["wall_ms"] != nil {
		t.Errorf("running row = %v", rows[0])
	}
	if rows[1]["status"] != "completed" || rows[1]["run_id"] != rows[0]["run_id"] {
		t.Errorf("final row = %v", rows[1])
	}
	if _, hasTimeline := rows[1]["timeline"]; hasTimeline {
		t.Error("index summary must not carry the timeline")
	}
	reportPath := filepath.Join(r.DataDir, *rep.RunID, "report.json")
	var stored report.Report
	data, _ := os.ReadFile(reportPath)
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	if len(stored.Timeline) != 1 || len(stored.Calls) != 1 {
		t.Errorf("stored = timeline %d calls %d", len(stored.Timeline), len(stored.Calls))
	}
	text := out.String()
	for _, want := range []string{"[meta/muse-wonder-full-1.0] wall 1200 ms · model 1000 ms",
		"in 100 · out 5 · 1 call(s)", "completed", "pong"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary missing %q in %q", want, text)
		}
	}
}

func TestRunPromptEchoRecordsEchoModel(t *testing.T) {
	result := fakeResult(Result{Calls: []report.Call{}})
	r, out := newFakeRunner(t, result)
	rep, err := r.RunPrompt(context.Background(), "hi", Options{Provider: "echo"})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Model == nil || *rep.Model != "echo" {
		t.Errorf("model = %v, want echo", rep.Model)
	}
	if rep.HarnessVersion != nil {
		t.Errorf("echo runs no harness, got %v", *rep.HarnessVersion)
	}
	if !strings.Contains(out.String(), "[echo/echo]") {
		t.Errorf("summary = %q", out.String())
	}
}

func TestRunPromptStatuses(t *testing.T) {
	tool := "FakeTool"
	cases := []struct {
		result Result
		status string
	}{
		{fakeResult(Result{ExitCode: 1}), "failed"},
		{fakeResult(Result{TimedOut: true, ExitCode: -15}), "timeout"},
		{fakeResult(Result{Interrupted: true, ExitCode: 130}), "interrupted"},
		{fakeResult(Result{NeedsApproval: &tool, ExitCode: -15}), "needs_approval"},
	}
	for _, c := range cases {
		r, out := newFakeRunner(t, c.result)
		rep, err := r.RunPrompt(context.Background(), "hi", Options{Provider: "meta"})
		if err != nil {
			t.Fatal(err)
		}
		if rep.Status == nil || *rep.Status != c.status {
			t.Errorf("status = %v want %s", rep.Status, c.status)
		}
		if c.status == "needs_approval" {
			if rep.Error == nil || !strings.Contains(*rep.Error, "waiting for approval: FakeTool") {
				t.Errorf("error = %v", rep.Error)
			}
			if !strings.Contains(out.String(), "WARNING: stopped") {
				t.Errorf("summary = %q", out.String())
			}
		}
	}
}

func TestRunPromptDispatchesEveryProvider(t *testing.T) {
	for _, provider := range []string{"anthropic", "claude-code", "codex", "meta", "echo"} {
		r, out := newFakeRunner(t, fakeResult(Result{}))
		rep, err := r.RunPrompt(context.Background(), "hi",
			Options{Provider: provider, Model: "m"})
		if err != nil {
			t.Fatalf("%s: %v", provider, err)
		}
		if rep.Provider == nil || *rep.Provider != provider {
			t.Errorf("%s recorded provider = %v", provider, rep.Provider)
		}
		switch provider {
		case "codex":
			if !strings.Contains(out.String(), "Codex run: may consume") {
				t.Errorf("codex notice missing: %q", out.String())
			}
		case "anthropic", "claude-code":
			if !strings.Contains(out.String(), "Paid run: uses") {
				t.Errorf("%s paid notice missing: %q", provider, out.String())
			}
		}
	}
}

func TestSummaryDashesWhenUnrecorded(t *testing.T) {
	result := fakeResult(Result{Calls: []report.Call{{InputTokens: i64(10)}}})
	r, out := newFakeRunner(t, result)
	if _, err := r.RunPrompt(context.Background(), "hi", Options{Provider: "meta"}); err != nil {
		t.Fatal(err)
	}
	text := out.String()
	if !strings.Contains(text, "model – · in 10 · out –") {
		t.Errorf("summary = %q", text)
	}
	if strings.Contains(text, "out 0") || strings.Contains(text, "out None") {
		t.Errorf("summary invented a value: %q", text)
	}
}

func TestValidateTaskChecks(t *testing.T) {
	runDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(runDir, "workspace"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runDir, "workspace", "hello.py"),
		[]byte("print('hi')"), 0o644); err != nil {
		t.Fatal(err)
	}
	none := ValidateTask(nil, "pong", runDir, "completed")
	if none.Status != "not_checked" || len(none.Checks) != 0 {
		t.Errorf("none = %+v", none)
	}
	checks := &Checks{ReplyContains: []string{"pong"}, FilesExist: []string{"hello.py", "missing.py"}}
	got := ValidateTask(checks, "pong", runDir, "completed")
	if got.Status != "failed" || !got.Checks[0].Passed || !got.Checks[1].Passed || got.Checks[2].Passed {
		t.Errorf("checks = %+v", got)
	}
	notDone := ValidateTask(checks, "pong", runDir, "failed")
	if notDone.Status != "not_checked" || notDone.Reason == nil {
		t.Errorf("not done = %+v", notDone)
	}
	escape := ValidateTask(&Checks{FilesExist: []string{"../escape"}}, "", runDir, "completed")
	if escape.Checks[0].Passed {
		t.Error("a path outside the workspace must never pass")
	}
}
