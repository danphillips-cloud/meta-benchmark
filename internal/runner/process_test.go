package runner

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunProcessCapturesLinesAndStderr(t *testing.T) {
	dir := t.TempDir()
	outPath := filepath.Join(dir, "events.jsonl")
	result, err := RunProcess(context.Background(),
		[]string{"sh", "-c", "printf 'a\nb\n'; echo oops >&2"},
		dir, os.Environ(), outPath, 10, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || result.TimedOut || result.Interrupted {
		t.Fatalf("result = %+v", result)
	}
	if len(result.Lines) != 2 || result.Lines[0].Line != "a\n" || result.Lines[1].Line != "b\n" {
		t.Fatalf("lines = %+v", result.Lines)
	}
	if result.Lines[1].ArrivalMS < result.Lines[0].ArrivalMS {
		t.Error("arrival stamps must not go backwards")
	}
	out, _ := os.ReadFile(outPath)
	if string(out) != "a\nb\n" {
		t.Errorf("stdout file = %q", out)
	}
	errText, _ := os.ReadFile(filepath.Join(dir, "stderr.log"))
	if !strings.Contains(string(errText), "oops") {
		t.Errorf("stderr file = %q", errText)
	}
	if result.WallMS < 0 {
		t.Errorf("wall = %d", result.WallMS)
	}
}

func TestRunProcessTimeoutKillsGroup(t *testing.T) {
	dir := t.TempDir()
	start := time.Now()
	result, err := RunProcess(context.Background(),
		[]string{"sh", "-c", "sleep 30"}, dir, os.Environ(),
		filepath.Join(dir, "events.jsonl"), 1, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(start)
	if !result.TimedOut {
		t.Fatalf("result = %+v", result)
	}
	if elapsed > 8*time.Second {
		t.Errorf("timeout took %v", elapsed)
	}
	if result.ExitCode == 0 {
		t.Errorf("killed process must not report exit 0: %+v", result)
	}
}

func TestRunProcessContextCancelIsInterrupted(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	result, err := RunProcess(ctx,
		[]string{"sh", "-c", "sleep 30"}, dir, os.Environ(),
		filepath.Join(dir, "events.jsonl"), 60, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Interrupted || result.TimedOut {
		t.Fatalf("result = %+v", result)
	}
}

func TestRunProcessWatchVerdictStops(t *testing.T) {
	dir := t.TempDir()
	tool := "FakeTool"
	polls := 0
	watch := func() *Verdict {
		polls++
		return &Verdict{Tool: &tool}
	}
	result, err := RunProcess(context.Background(),
		[]string{"sh", "-c", "sleep 30"}, dir, os.Environ(),
		filepath.Join(dir, "events.jsonl"), 60, nil, watch, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.NeedsApproval == nil || *result.NeedsApproval != "FakeTool" {
		t.Fatalf("result = %+v", result)
	}
	if polls == 0 {
		t.Error("watch was never polled")
	}
}

func TestRunProcessMissingBinaryErrors(t *testing.T) {
	dir := t.TempDir()
	_, err := RunProcess(context.Background(),
		[]string{"meta-benchmark-no-such-binary"}, dir, os.Environ(),
		filepath.Join(dir, "events.jsonl"), 5, nil, nil, nil)
	if err == nil {
		t.Fatal("missing binary must error like Python OSError")
	}
}
