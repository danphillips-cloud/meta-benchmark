package runner

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"meta-benchmark/internal/muselog"
	"meta-benchmark/internal/pricing"
)

func quietRunner(t *testing.T) *Runner {
	t.Helper()
	r := New(t.TempDir())
	r.Out = &strings.Builder{}
	r.ErrOut = &strings.Builder{}
	r.HarnessVersionFn = func(string) *string { return nil }
	r.AllowanceStartFn = func() *pricing.Allowance { return nil }
	return r
}

func TestRecordWatchTurn(t *testing.T) {
	records := muselog.ReadRecords(filepath.Join("..", "..", "testdata", "fixtures", "session-turns.jsonl"))
	turns := muselog.SplitTurns(records)
	if len(turns) != 2 {
		t.Fatalf("turns = %d", len(turns))
	}
	r := quietRunner(t)
	rep, err := r.RecordWatchTurn(turns[0], "fake-session", "muse-watch", "./run-muse --watch", true)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Provider == nil || *rep.Provider != "muse-watch" ||
		rep.TurnIndex == nil || *rep.TurnIndex != 1 ||
		rep.ContextMode == nil || *rep.ContextMode != "interactive" {
		t.Errorf("report = provider %v turn %v context %v", rep.Provider, rep.TurnIndex, rep.ContextMode)
	}
	if rep.OutcomeRecorded == nil || *rep.OutcomeRecorded {
		t.Errorf("unknown outcome must record false, got %v", rep.OutcomeRecorded)
	}
	rows := readIndex(t, r)
	if len(rows) != 1 || rows[0]["provider"] != "muse-watch" {
		t.Fatalf("rows = %v", rows)
	}
	prompt, err := os.ReadFile(filepath.Join(r.DataDir, *rep.RunID, "prompt.md"))
	if err != nil || string(prompt) != "fake prompt one" {
		t.Errorf("prompt.md = %q %v", prompt, err)
	}
}

func sessionSetup(t *testing.T, sid, fixture string) string {
	t.Helper()
	sessions := t.TempDir()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "fixtures", fixture))
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(sessions, sid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "session.jsonl"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MUSE_SESSIONS_DIR", sessions)
	return sessions
}

func TestRunWatchEndedSessionRecordsTurns(t *testing.T) {
	sessionSetup(t, "fake-watch", "session-turns.jsonl")
	r := quietRunner(t)
	stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	r.RunWatch(stopCtx, "fake-watch")
	rows := readIndex(t, r)
	if len(rows) != 2 {
		t.Fatalf("recorded rows = %d", len(rows))
	}
	out := r.Out.(*strings.Builder).String()
	if !strings.Contains(out, "Watching session fake-watch") || !strings.Contains(out, "Session ended.") {
		t.Errorf("out = %q", out)
	}
}

func TestRunRetroImportsOnceAndSkipsOwned(t *testing.T) {
	sessionSetup(t, "fake-retro", "session-turns.jsonl")
	r := quietRunner(t)
	r.RunRetro()
	rows := readIndex(t, r)
	if len(rows) != 2 {
		t.Fatalf("first retro rows = %d", len(rows))
	}
	r.RunRetro()
	if rows := readIndex(t, r); len(rows) != 2 {
		t.Fatalf("second retro must import nothing, rows = %d", len(rows))
	}
	out := r.Out.(*strings.Builder).String()
	if !strings.Contains(out, "Imported 2 turn(s) from 1 session(s)") {
		t.Errorf("out = %q", out)
	}
	for _, row := range rows {
		if row["provider"] != "muse-retro" {
			t.Errorf("row provider = %v", row["provider"])
		}
	}
}

func TestRetroPlanSkipsLauncherOwnedSession(t *testing.T) {
	records := muselog.ReadRecords(filepath.Join("..", "..", "testdata", "fixtures", "session-turns.jsonl"))
	sessions := []SessionTurns{{SessionID: "s1", Turns: muselog.SplitTurns(records)}}
	entries := []map[string]any{
		{"session_id": "s1", "provider": "meta", "run_id": "launcher-run"},
	}
	if plan := RetroPlan(entries, sessions); len(plan) != 0 {
		t.Errorf("launcher-owned session must be skipped whole: %v", plan)
	}
	entries = []map[string]any{
		{"session_id": "s1", "provider": "muse-watch", "turn_index": float64(1), "run_id": "w1"},
	}
	plan := RetroPlan(entries, sessions)
	if len(plan) != 1 || plan[0].Turn.Index != 2 {
		t.Errorf("plan = %+v", plan)
	}
}
