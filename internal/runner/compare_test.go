package runner

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"meta-benchmark/internal/pricing"
)

// Mirrors ExitCodeTest compare aggregation and RaceTest intent
// from tests/test_tool.py.

func statusResult(status string) Result {
	result := fakeResult(Result{})
	switch status {
	case "failed":
		result.ExitCode = 1
	case "interrupted":
		result.Interrupted = true
		result.ExitCode = 130
	case "timeout":
		result.TimedOut = true
		result.ExitCode = 1
	}
	return result
}

func compareRunner(t *testing.T, statuses []string, calls *int) (*Runner, *strings.Builder) {
	t.Helper()
	t.Setenv("COMPARE_META", "meta:a,meta:b")
	t.Setenv("MUSE_SESSIONS_DIR", t.TempDir())
	out := &strings.Builder{}
	r := New(t.TempDir())
	r.Out = out
	r.ErrOut = &strings.Builder{}
	r.HarnessVersionFn = func(string) *string { return nil }
	r.AllowanceStartFn = func() *pricing.Allowance { return nil }
	next := 0
	r.MuseExec = func(ctx context.Context, prompt, runDir, provider, model string,
		minimal bool, timeoutSeconds int, sessionID, legLabel string, w io.Writer) Result {
		if calls != nil {
			*calls++
		}
		status := statuses[next]
		if next < len(statuses)-1 {
			next++
		}
		return statusResult(status)
	}
	return r, out
}

func TestRunCompareAggregatesStatuses(t *testing.T) {
	cases := []struct {
		statuses []string
		want     int
	}{
		{[]string{"completed", "failed"}, 1},
		{[]string{"completed", "interrupted"}, 130},
		{[]string{"completed", "completed"}, 0},
	}
	for _, c := range cases {
		r, out := compareRunner(t, append([]string(nil), c.statuses...), nil)
		code, err := r.RunCompare(context.Background(), "hi", "meta", false, nil, 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if code != c.want {
			t.Errorf("statuses %v: code %d want %d", c.statuses, code, c.want)
		}
		if !strings.Contains(out.String(), "Comparing 2 model(s), 1 round(s), set ") {
			t.Errorf("header missing: %q", out.String())
		}
		if !strings.Contains(out.String(), "done:") {
			t.Errorf("closing missing: %q", out.String())
		}
	}
}

func TestRunCompareStopsAfterInterruptedLeg(t *testing.T) {
	calls := 0
	r, _ := compareRunner(t, []string{"interrupted"}, &calls)
	code, err := r.RunCompare(context.Background(), "hi", "meta", false, nil, 3, false)
	if err != nil {
		t.Fatal(err)
	}
	if code != 130 || calls != 1 {
		t.Errorf("code=%d calls=%d, want 130 and one leg only", code, calls)
	}
}

func TestRunCompareRacesLegsConcurrently(t *testing.T) {
	t.Setenv("COMPARE_META", "meta:a,meta:b")
	t.Setenv("MUSE_SESSIONS_DIR", t.TempDir())
	r := New(t.TempDir())
	r.Out = io.Discard
	r.ErrOut = io.Discard
	r.HarnessVersionFn = func(string) *string { return nil }
	r.AllowanceStartFn = func() *pricing.Allowance { return nil }
	started := make(chan string, 2)
	release := make(chan struct{})
	var once sync.Once
	r.MuseExec = func(ctx context.Context, prompt, runDir, provider, model string,
		minimal bool, timeoutSeconds int, sessionID, legLabel string, w io.Writer) Result {
		started <- model
		<-release
		return statusResult("completed")
	}
	// Release both legs once both have started.
	go func() {
		<-started
		<-started
		once.Do(func() { close(release) })
	}()
	done := make(chan int, 1)
	go func() {
		code, err := r.RunCompare(context.Background(), "hi", "meta", false, nil, 1, true)
		if err != nil {
			t.Errorf("race: %v", err)
			done <- -1
			return
		}
		done <- code
	}()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("race code = %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("raced legs never overlapped or never finished")
	}
	rows := readIndex(t, r)
	racedFinal := 0
	for _, row := range rows {
		if row["raced"] == true && row["status"] == "completed" {
			racedFinal++
		}
	}
	if racedFinal != 2 {
		t.Errorf("raced final rows = %d of %d", racedFinal, len(rows))
	}
}
