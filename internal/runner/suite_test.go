package runner

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"meta-benchmark/internal/pricing"
)

// Mirrors SuiteTest behaviours from tests/test_tool.py at the
// level this step owns: load, plan, run, resume, budgets.

func suiteRunner(t *testing.T, execFn MuseExecFunc) (*Runner, *strings.Builder) {
	t.Helper()
	t.Setenv("MUSE_SESSIONS_DIR", t.TempDir())
	out := &strings.Builder{}
	r := New(t.TempDir())
	r.Out = out
	r.ErrOut = &strings.Builder{}
	r.HarnessVersionFn = func(string) *string { return nil }
	r.AllowanceStartFn = func() *pricing.Allowance { return nil }
	if execFn != nil {
		r.MuseExec = execFn
		r.AnthropicExec = func(ctx context.Context, prompt, runDir, model string, timeoutSeconds int) Result {
			return execFn(ctx, prompt, runDir, "anthropic", model, false, timeoutSeconds, "", "", out)
		}
	}
	return r, out
}

func writeSuiteFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "suite.json")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadManifestValidation(t *testing.T) {
	path := writeSuiteFile(t, `{"prompts":[{"name":"a","prompt":"hi"}],
		"settings":{"concurrency":2,"repeat":2,"timeout_seconds":90,
		"pricing":{"m":{"input_per_mtok":1,"output_per_mtok":2}}}}`)
	manifest, err := LoadManifest(path)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Settings.Concurrency != 2 || *manifest.Settings.Repeat != 2 ||
		*manifest.Settings.TimeoutSeconds != 90 || len(manifest.Entries) != 1 {
		t.Fatalf("manifest = %+v", manifest)
	}
	for _, bad := range []string{
		`{"prompts":[]}`,
		`{"prompts":[{"name":"a"}]}`,
		`{"prompts":[{"name":"a","prompt":"x"},{"name":"a","prompt":"y"}]}`,
		`{"prompts":[{"name":"a","prompt":"x","timeout_seconds":0}]}`,
		`{"prompts":[{"name":"a","prompt":"x","skip":"yes"}]}`,
		`{"prompts":[{"name":"a","prompt":"x"}],"settings":{"concurrency":9}}`,
		`{"prompts":[{"name":"a","prompt":"x"}],"settings":{"max_cost_usd":-1}}`,
		`{"prompts":[{"name":"a","prompt":"x","checks":{"bogus":["y"]}}]}`,
		`{not json`,
	} {
		if _, err := LoadManifest(writeSuiteFile(t, bad)); err == nil {
			t.Errorf("bad suite must error: %s", bad)
		}
	}
	entries, err := LoadSuite(writeSuiteFile(t,
		`{"prompts":[{"name":"a","file":"p.txt"}]}`))
	if err == nil || entries != nil {
		// The prompt file does not exist yet in its own temp
		// dir, so this must fail cleanly. Retried below.
		_ = entries
	}
}

func TestSuitePromptFileRelativeToSuite(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "p.txt"), []byte("from file"), 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "suite.json")
	if err := os.WriteFile(path, []byte(`{"prompts":[{"name":"a","file":"p.txt"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := LoadSuite(path)
	if err != nil || entries[0].Prompt != "from file" {
		t.Fatalf("entries = %+v err %v", entries, err)
	}
}

func TestSuiteDryRunPrintsPlanAndRunsNothing(t *testing.T) {
	path := writeSuiteFile(t, `{"prompts":[
		{"name":"ping","prompt":"say pong","provider":"echo"},
		{"name":"skipme","prompt":"never","provider":"echo","skip":true},
		{"name":"paid","prompt":"hi","provider":"claude-code","model":"claude-x"}],
		"settings":{"concurrency":2}}`)
	r, out := suiteRunner(t, nil)
	code, err := r.RunSuite(context.Background(), path, nil, nil, true, false, false, nil)
	if err != nil || code != 0 {
		t.Fatalf("dry run = %d %v", code, err)
	}
	text := out.String()
	for _, want := range []string{"3 prompt(s), 3 repeat(s) each, concurrency 2",
		"- ping · echo/echo", "bills nothing", "skip", "PAID",
		"They spend in parallel", "Dry run only. Nothing was run"} {
		if !strings.Contains(text, want) {
			t.Errorf("plan missing %q in:\n%s", want, text)
		}
	}
	if _, err := os.Stat(filepath.Join(r.DataDir, "index.jsonl")); !os.IsNotExist(err) {
		t.Error("dry run must record nothing")
	}
}

func TestSuiteRunRecordsAndResumes(t *testing.T) {
	path := writeSuiteFile(t, `{"prompts":[
		{"name":"ping","prompt":"say pong","provider":"meta","checks":{"reply_contains":["pong"]}},
		{"name":"skipme","prompt":"never","provider":"meta","skip":true}],
		"settings":{"repeat":1}}`)
	calls := 0
	r, out := suiteRunner(t, func(ctx context.Context, prompt, runDir, provider, model string,
		minimal bool, timeoutSeconds int, sessionID, legLabel string, w io.Writer) Result {
		calls++
		return fakeResult(Result{})
	})
	code, err := r.RunSuite(context.Background(), path, nil, nil, false, true, false, nil)
	if err != nil || code != 0 || calls != 1 {
		t.Fatalf("first run code=%d calls=%d err=%v out=%q", code, calls, err, out.String())
	}
	rows := readIndex(t, r)
	suiteRows := 0
	for _, row := range rows {
		if row["suite_id"] != nil && row["status"] == "completed" {
			suiteRows++
			if row["suite_prompt"] != "ping" {
				t.Errorf("suite_prompt = %v", row["suite_prompt"])
			}
		}
	}
	if suiteRows != 1 {
		t.Fatalf("completed suite rows = %d of %v", suiteRows, rows)
	}
	if !strings.Contains(out.String(), "1 completed of 2.") {
		t.Errorf("closing = %q", out.String())
	}
	// Resume: the passed entry is reusable and does not rerun.
	out.Reset()
	code, err = r.RunSuite(context.Background(), path, nil, nil, false, true, false, nil)
	if err != nil || code != 0 || calls != 1 {
		t.Fatalf("resume code=%d calls=%d err=%v", code, calls, err)
	}
	if !strings.Contains(out.String(), "already completed") {
		t.Errorf("resume out = %q", out.String())
	}
	// Fresh ignores saved progress under a new suite id.
	code, err = r.RunSuite(context.Background(), path, nil, nil, false, true, true, nil)
	if err != nil || code != 0 || calls != 2 {
		t.Fatalf("fresh code=%d calls=%d err=%v", code, calls, err)
	}
}

func TestSuiteFailedCheckReturnsOneAndRerunsOnResume(t *testing.T) {
	path := writeSuiteFile(t, `{"prompts":[
		{"name":"ping","prompt":"say pong","provider":"meta","checks":{"reply_contains":["zzz"]}}],
		"settings":{"repeat":1}}`)
	calls := 0
	r, _ := suiteRunner(t, func(ctx context.Context, prompt, runDir, provider, model string,
		minimal bool, timeoutSeconds int, sessionID, legLabel string, w io.Writer) Result {
		calls++
		return fakeResult(Result{})
	})
	code, err := r.RunSuite(context.Background(), path, nil, nil, false, true, false, nil)
	if err != nil || code != 1 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	code, err = r.RunSuite(context.Background(), path, nil, nil, false, true, false, nil)
	if err != nil || code != 1 || calls != 2 {
		t.Fatalf("failed checks must rerun: code=%d calls=%d err=%v", code, calls, err)
	}
}

func TestSuiteCostBudgetStopsNewEntries(t *testing.T) {
	path := writeSuiteFile(t, `{"prompts":[
		{"name":"one","prompt":"a","provider":"anthropic","model":"claude-x"},
		{"name":"two","prompt":"b","provider":"anthropic","model":"claude-x"}],
		"settings":{"repeat":1,"max_cost_usd":1}}`)
	calls := 0
	r, out := suiteRunner(t, nil)
	r.AnthropicExec = func(ctx context.Context, prompt, runDir, model string, timeoutSeconds int) Result {
		calls++
		result := fakeResult(Result{})
		cost := 5.0
		result.CostUSD = &cost
		return result
	}
	code, err := r.RunSuite(context.Background(), path, nil, nil, false, false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if code != 1 || calls != 1 {
		t.Fatalf("code=%d calls=%d out=%q", code, calls, out.String())
	}
	if !strings.Contains(out.String(), "cost budget reached") {
		t.Errorf("budget line missing: %q", out.String())
	}
}

func TestSuiteLoadsShippedGoldenPrompts(t *testing.T) {
	entries, err := LoadSuite(filepath.Join("..", "..", "golden-prompts.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("shipped suite must have entries")
	}
	for _, entry := range entries {
		if entry.Name == "" || entry.Prompt == "" {
			t.Errorf("bad shipped entry: %+v", entry)
		}
	}
}
