package streams

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// These cases mirror ClaudeStreamTest, ClaudeLiveTest and
// CodexTest in tests/test_tool.py. The Python tests are the spec.

func fixtureLines(t *testing.T, name string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(string(data), "\n"), "\n")
}

func f64(v float64) *float64 { return &v }

func stampEvery(lines []string, step float64) []Stamped {
	out := make([]Stamped, 0, len(lines))
	for i, line := range lines {
		out = append(out, Stamped{ArrivalMS: f64(float64(i) * step), Line: line})
	}
	return out
}

func eqI(t *testing.T, label string, got *int64, want int64) {
	t.Helper()
	if got == nil || *got != want {
		t.Errorf("%s = %v, want %v", label, got, want)
	}
}

func eqF(t *testing.T, label string, got *float64, want float64) {
	t.Helper()
	if got == nil || *got != want {
		t.Errorf("%s = %v, want %v", label, got, want)
	}
}

func TestInputWithCacheIsStrict(t *testing.T) {
	full := map[string]any{
		"input_tokens": json.Number("4"), "cache_read_input_tokens": json.Number("10"),
		"cache_creation_input_tokens": json.Number("2")}
	eqI(t, "full", InputWithCache(full), 16)
	zeros := map[string]any{
		"input_tokens": json.Number("0"), "cache_read_input_tokens": json.Number("0"),
		"cache_creation_input_tokens": json.Number("0")}
	eqI(t, "zeros stay a recorded 0", InputWithCache(zeros), 0)
	partial := map[string]any{
		"input_tokens": json.Number("4"), "cache_read_input_tokens": json.Number("10")}
	if InputWithCache(partial) != nil {
		t.Error("missing part must give nil")
	}
	if InputWithCache(map[string]any{}) != nil {
		t.Error("empty usage must give nil")
	}
}

func TestClaudeFixtureMapsToCallsAndTotals(t *testing.T) {
	lines := fixtureLines(t, "claude-code-stream.jsonl")
	parsed := ParseClaudeStream(stampEvery(lines, 100))
	if len(parsed.Calls) != 2 {
		t.Fatalf("calls = %d", len(parsed.Calls))
	}
	eqI(t, "call0 input", parsed.Calls[0].InputTokens, 1682)
	eqI(t, "call1 input", parsed.Calls[1].InputTokens, 1787)
	eqI(t, "call0 cached", parsed.Calls[0].CachedTokens, 1495)
	eqI(t, "call1 cached", parsed.Calls[1].CachedTokens, 1678)
	for _, c := range parsed.Calls {
		if c.DurationMS != nil || c.OutputTokens != nil {
			t.Errorf("duration/output must stay nil: %+v", c)
		}
	}
	if parsed.Totals == nil {
		t.Fatal("missing totals")
	}
	eqI(t, "totals input", parsed.Totals.InputTokens, 3469)
	eqI(t, "totals output", parsed.Totals.OutputTokens, 139)
	eqI(t, "totals cached", parsed.Totals.CachedTokens, 3173)
	eqF(t, "api", parsed.APIMS, 2736)
	eqF(t, "ttft", parsed.TTFTMS, 1327)
	eqI(t, "turns", parsed.NumTurns, 2)
	if parsed.IsError {
		t.Error("is_error must be false")
	}
	if !strings.HasPrefix(parsed.Reply, "I created `hello.py`") {
		t.Errorf("reply = %q", parsed.Reply)
	}
	if len(parsed.Timeline) != 6 {
		t.Fatalf("timeline = %d", len(parsed.Timeline))
	}
	for i, row := range parsed.Timeline {
		if row.WireMS != nil {
			t.Errorf("wire must stay nil at %d", i)
		}
		if i < 5 {
			eqF(t, "duration", row.DurationMS, 100)
		} else if row.DurationMS != nil {
			t.Error("last duration must stay nil")
		}
	}
}

func TestClaudeSyntheticAndZeroUsageAreNotCounted(t *testing.T) {
	lines := []string{
		`{"type":"assistant","message":{"id":"msg_meta","model":"muse-wonder-1.0","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
		`{"type":"assistant","message":{"id":"msg_err","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"4","duration_api_ms":4105,"usage":{"input_tokens":1370,"output_tokens":15}}`,
	}
	parsed := ParseClaudeStream(stampEvery(lines, 100))
	if len(parsed.Calls) != 1 {
		t.Fatalf("calls = %d", len(parsed.Calls))
	}
	if parsed.Calls[0].InputTokens != nil || parsed.Calls[0].CachedTokens != nil {
		t.Errorf("zero usage must stay unknown: %+v", parsed.Calls[0])
	}
	if parsed.UsageModel == nil || *parsed.UsageModel != "muse-wonder-1.0" {
		t.Errorf("usage model = %v", parsed.UsageModel)
	}
	// Strict: result usage omits cache parts, so the input
	// total including cache is unknown. Never 1370 alone.
	if parsed.Totals == nil || parsed.Totals.InputTokens != nil {
		t.Errorf("totals = %+v", parsed.Totals)
	}
}

func TestClaudeUnstampedParseHasNoDurations(t *testing.T) {
	lines := fixtureLines(t, "claude-code-stream.jsonl")
	stamped := ParseClaudeStream(stampEvery(lines, 100))
	var unstamped []Stamped
	for _, line := range lines {
		unstamped = append(unstamped, Stamped{Line: line})
	}
	plain := ParseClaudeStream(unstamped)
	if !reflect.DeepEqual(plain.Calls, stamped.Calls) {
		t.Error("calls differ between stamped and unstamped")
	}
	if !reflect.DeepEqual(plain.Totals, stamped.Totals) {
		t.Error("totals differ between stamped and unstamped")
	}
	for _, row := range plain.Timeline {
		if row.DurationMS != nil {
			t.Error("unstamped durations must stay nil")
		}
	}
}

func TestClaudeLiveStatesFromFixturePrefixes(t *testing.T) {
	lines := fixtureLines(t, "claude-code-stream.jsonl")
	live := LiveFromLines(lines[:3])
	if live.LiveState.State != "tool running" || live.LiveState.Tool == nil || *live.LiveState.Tool != "Bash" {
		t.Errorf("prefix 3 = %+v", live.LiveState)
	}
	if len(live.Calls) != 1 {
		t.Errorf("prefix 3 calls = %d", len(live.Calls))
	}
	if got := LiveFromLines(lines[:4]).LiveState.State; got != "model call running" {
		t.Errorf("prefix 4 = %s", got)
	}
	live = LiveFromLines(lines)
	if live.LiveState.State != "ended" || len(live.Calls) != 2 {
		t.Errorf("full = %+v calls=%d", live.LiveState, len(live.Calls))
	}
	if got := LiveFromLines(nil).LiveState.State; got != "idle" {
		t.Errorf("empty = %s", got)
	}
}

func TestClaudeMultiBlockMessageRegistersItsTool(t *testing.T) {
	usage := `"usage":{"input_tokens":100,"output_tokens":3}`
	lines := []string{
		`{"type":"system","subtype":"init","session_id":"s1"}`,
		`{"type":"assistant","message":{"id":"m1","model":"claude-sonnet-5-5",` + usage + `,"content":[{"type":"text","text":"working"}]}}`,
		`{"type":"assistant","message":{"id":"m1","model":"claude-sonnet-5-5",` + usage + `,"content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}`,
		`{"type":"assistant","message":{"id":"m2","model":"claude-sonnet-5-5",` + usage + `,"content":[{"type":"text","text":"done"}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"done",` + usage + `}`,
	}
	live := LiveFromLines(lines[:3])
	if live.LiveState.State != "tool running" || live.LiveState.Tool == nil || *live.LiveState.Tool != "Bash" {
		t.Errorf("live = %+v", live.LiveState)
	}
	if len(live.Calls) != 1 {
		t.Errorf("one message must give one call, got %d", len(live.Calls))
	}
	if live.SessionID == nil || *live.SessionID != "s1" {
		t.Errorf("session = %v", live.SessionID)
	}
	parsed := ParseClaudeStream(stampEvery(lines, 100))
	if len(parsed.Calls) != 2 {
		t.Errorf("parsed calls = %d", len(parsed.Calls))
	}
}

func TestTrackerFeedReturnsCallOncePerMessage(t *testing.T) {
	tracker := NewLiveTracker()
	event := map[string]any{
		"type":    "assistant",
		"message": map[string]any{"id": "m1", "model": "m", "usage": map[string]any{}},
	}
	if _, fresh := tracker.FeedLiveEvent(event); !fresh {
		t.Fatal("first event must give a fresh call")
	}
	if _, fresh := tracker.FeedLiveEvent(event); fresh {
		t.Fatal("same message id must not give a second call")
	}
	if len(tracker.Calls()) != 1 {
		t.Fatalf("calls = %d", len(tracker.Calls()))
	}
	if _, fresh := tracker.FeedLiveEvent(nil); fresh {
		t.Fatal("nil event must be ignored")
	}
}
