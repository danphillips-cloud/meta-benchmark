package runner

import (
	"math"
	"os"
	"path/filepath"
	"testing"

	"meta-benchmark/internal/pricing"
)

// Mirrors DotenvTest, DefaultModelTest, and the parse and
// compute parts of PricingTest in tests/test_tool.py.

func TestDotenvParsingAndEnvWins(t *testing.T) {
	keys := []string{"BENCH_DOTENV_PLAIN", "BENCH_DOTENV_QUOTED", "BENCH_DOTENV_SINGLE",
		"BENCH_DOTENV_SPACED", "BENCH_DOTENV_EQUALS", "BENCH_DOTENV_WINS"}
	for _, k := range keys {
		os.Unsetenv(k)
		defer os.Unsetenv(k)
	}
	t.Setenv("BENCH_DOTENV_WINS", "from-env")
	path := filepath.Join(t.TempDir(), "dotenv-fixture.txt")
	content := "# a comment\n\nBENCH_DOTENV_PLAIN=plain-value\n" +
		"BENCH_DOTENV_QUOTED=\"double quoted\"\nBENCH_DOTENV_SINGLE='single quoted'\n" +
		"BENCH_DOTENV_SPACED = spaced value \nBENCH_DOTENV_EQUALS=a=b\n" +
		"BENCH_DOTENV_WINS=from-file\na line without an equals sign\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	LoadDotenv(path)
	wants := map[string]string{
		"BENCH_DOTENV_PLAIN": "plain-value", "BENCH_DOTENV_QUOTED": "double quoted",
		"BENCH_DOTENV_SINGLE": "single quoted", "BENCH_DOTENV_SPACED": "spaced value",
		"BENCH_DOTENV_EQUALS": "a=b", "BENCH_DOTENV_WINS": "from-env",
	}
	for k, want := range wants {
		if got := os.Getenv(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	LoadDotenv(filepath.Join(t.TempDir(), "missing.txt")) // must not panic
}

func TestDefaultModelIsPerProvider(t *testing.T) {
	t.Setenv("MUSE_MODEL", "meta-sentinel")
	t.Setenv("BENCH_CLAUDE_MODEL", "claude-sentinel")
	t.Setenv("ANTHROPIC_MODEL", "muse-wonder-1.0")
	if got, _ := DefaultModel("meta"); got != "meta-sentinel" {
		t.Errorf("meta = %q", got)
	}
	for _, p := range []string{"anthropic", "claude-code"} {
		if got, _ := DefaultModel(p); got != "claude-sentinel" {
			t.Errorf("%s = %q", p, got)
		}
	}
	models := ParseCompareModels("meta, anthropic, meta:custom-meta, anthropic:custom-claude")
	want := []ProviderModel{
		{"meta", "meta-sentinel", true}, {"anthropic", "claude-sentinel", true},
		{"meta", "custom-meta", true}, {"anthropic", "custom-claude", true}}
	if len(models) != len(want) {
		t.Fatalf("models = %+v", models)
	}
	for i := range want {
		if models[i] != want[i] {
			t.Errorf("model %d = %+v want %+v", i, models[i], want[i])
		}
	}
}

func TestAnthropicModelEnvDoesNotChangeDefault(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "muse-wonder-1.0")
	os.Unsetenv("BENCH_CLAUDE_MODEL")
	for _, p := range []string{"anthropic", "claude-code"} {
		if got, _ := DefaultModel(p); got == "muse-wonder-1.0" || got != "claude-sonnet-5-5" {
			t.Errorf("%s = %q", p, got)
		}
	}
	if _, err := ResolveModel("codex", ""); err == nil {
		t.Error("codex without a model must error before work")
	}
	if got, err := ResolveModel("codex", "  gpt-x  "); err != nil || got != "gpt-x" {
		t.Errorf("codex trim = %q %v", got, err)
	}
}

func TestExitCodeFor(t *testing.T) {
	cases := map[string]int{"completed": 0, "interrupted": 130,
		"failed": 1, "timeout": 1, "needs_approval": 1}
	for status, want := range cases {
		if got := ExitCodeFor(status); got != want {
			t.Errorf("%s = %d want %d", status, got, want)
		}
	}
}

func TestParsePricingShapesAndRejectsBadValues(t *testing.T) {
	if got, err := ParsePricing(nil, ""); err != nil || len(got) != 0 {
		t.Errorf("nil = %v %v", got, err)
	}
	flat, err := ParsePricing(map[string]any{
		"input_per_mtok": 4.0, "output_per_mtok": 20.0}, "")
	if err != nil || flat["*"].InputPerMTok == nil || *flat["*"].InputPerMTok != 4.0 {
		t.Errorf("flat = %+v %v", flat, err)
	}
	byModel, err := ParsePricing(`{"m1": {"input_per_mtok": 1, "output_per_mtok": 2}}`, "")
	if err != nil || *byModel["m1"].OutputPerMTok != 2.0 {
		t.Errorf("by model = %+v %v", byModel, err)
	}
	for _, raw := range []any{
		"{not json", []any{},
		map[string]any{"m": map[string]any{"input_per_mtok": -1.0, "output_per_mtok": 2.0}},
		map[string]any{"m": map[string]any{"input_per_mtok": 1.0}},
		map[string]any{"m": map[string]any{"input_per_mtok": true, "output_per_mtok": 2.0}},
	} {
		if _, err := ParsePricing(raw, ""); err == nil {
			t.Errorf("raw %v must error", raw)
		}
	}
}

func i64(v int64) *int64 { return &v }

func TestComputeCostFromTotalsAndCalls(t *testing.T) {
	rates, err := ParsePricing(map[string]any{
		"m": map[string]any{"input_per_mtok": 4.0, "output_per_mtok": 20.0}}, "")
	if err != nil {
		t.Fatal(err)
	}
	got := ComputeCost("m", &pricing.Tokens{Input: i64(1000000), Output: i64(500000)},
		nil, false, nil, rates)
	if got == nil || math.Abs(got.CostUSD-14.0) > 1e-9 || got.Used["model"] != "m" {
		t.Fatalf("totals cost = %+v", got)
	}
	calls := []pricing.Tokens{
		{Input: i64(10), Output: i64(5)}, {Input: i64(20), Output: i64(5)}}
	got = ComputeCost("m", nil, nil, false, calls, rates)
	want := (30*4 + 10*20) / 1000000.0
	if got == nil || math.Abs(got.CostUSD-want) > 1e-12 {
		t.Fatalf("calls cost = %+v want %v", got, want)
	}
	flat, _ := ParsePricing(map[string]any{
		"input_per_mtok": 1.0, "output_per_mtok": 1.0}, "")
	if ComputeCost("m", nil, nil, false, nil, flat) != nil {
		t.Error("no data must give nil")
	}
	partial := []pricing.Tokens{{Input: i64(10)}}
	if ComputeCost("m", nil, nil, false, partial, flat) != nil {
		t.Error("partial call must give nil")
	}
	other, _ := ParsePricing(map[string]any{
		"other": map[string]any{"input_per_mtok": 1.0, "output_per_mtok": 1.0}}, "")
	if ComputeCost("m", &pricing.Tokens{Input: i64(5), Output: i64(5)}, nil, false, nil, other) != nil {
		t.Error("unpriced model must give nil")
	}
}

func TestHandleCommandModes(t *testing.T) {
	shown := HandleCommand("/mode", "single")
	if shown.Action != "message" || shown.Text != "Mode: single" {
		t.Errorf("shown = %+v", shown)
	}
	switched := HandleCommand("/mode meta", "single")
	if switched.Mode != "meta" || !contains(switched.Text, "meta vs meta") ||
		!contains(switched.Text, "muse-wonder-full-1.0") {
		t.Errorf("switched = %+v", switched)
	}
	bad := HandleCommand("/mode bogus", "claude")
	if bad.Mode != "claude" || !contains(bad.Text, "Unknown mode") {
		t.Errorf("bad = %+v", bad)
	}
	if back := HandleCommand("/mode single", "meta"); back.Mode != "single" {
		t.Errorf("back = %+v", back)
	}
	help := HandleCommand("/help", "single")
	if help.Action != "message" || !contains(help.Text, "/mode single|meta|claude|custom") {
		t.Errorf("help = %+v", help)
	}
	if got := HandleCommand("/quit", "meta"); got.Action != "quit" {
		t.Errorf("quit = %+v", got)
	}
	prompt := HandleCommand("what is 2+2", "meta")
	if prompt != (CommandResult{Action: "prompt", Mode: "meta", Text: "what is 2+2"}) {
		t.Errorf("prompt = %+v", prompt)
	}
	if got := HandleCommand("  ", "single"); got.Action != "none" {
		t.Errorf("empty = %+v", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
