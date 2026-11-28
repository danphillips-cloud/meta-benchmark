package muselog

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

// These cases mirror the muse_log tests in tests/test_tool.py
// (HarvestTest, LogParsingFixTest, VisibilityTest,
// ReportingAccuracyTest). The Python tests are the spec.

func records(t *testing.T, name string) []Record {
	t.Helper()
	return ReadRecords(filepath.Join("..", "..", "testdata", "fixtures", name))
}

func eqF(t *testing.T, label string, got *float64, want float64) {
	t.Helper()
	if got == nil || math.Abs(*got-want) > 1e-9 {
		t.Errorf("%s = %v, want %v", label, got, want)
	}
}

func isNilF(t *testing.T, label string, got *float64) {
	t.Helper()
	if got != nil {
		t.Errorf("%s = %v, want nil", label, *got)
	}
}

func eqI(t *testing.T, label string, got *int64, want int64) {
	t.Helper()
	if got == nil || *got != want {
		t.Errorf("%s = %v, want %v", label, got, want)
	}
}

func anyNum(v any) (float64, bool) { return numVal(v) }

const sessionRecord = `{"recorded_at":1792791769858843,"payload_type":"runtime.session","payload":{"kind":"run","event":{"kind":"model_completed","duration_ms":10474,"usage":{"input_tokens":31651,"output_tokens":35,"cached_tokens":0,"reasoning_tokens":25}}}}`

func TestHarvestAndTimelineFromSessionLog(t *testing.T) {
	td := t.TempDir()
	sid := "test-session-1"
	dir := filepath.Join(td, sid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	end := `{"recorded_at":1792791774858843,"payload_type":"session.end","payload":{"kind":"session_end"}}`
	if err := os.WriteFile(filepath.Join(dir, "session.jsonl"),
		[]byte(sessionRecord+"\n"+end+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MUSE_SESSIONS_DIR", td)
	calls := HarvestCalls(sid)
	if len(calls) != 1 {
		t.Fatalf("calls = %d", len(calls))
	}
	eqF(t, "duration", calls[0].DurationMS, 10474)
	eqI(t, "input", calls[0].InputTokens, 31651)
	eqI(t, "output", calls[0].OutputTokens, 35)
	timeline := BuildTimeline(sid, 16001)
	if len(timeline) == 0 {
		t.Fatal("empty timeline")
	}
	eqF(t, "wire", timeline[0].WireMS, 10474)
	eqI(t, "timeline duration", timeline[0].DurationMS, 5000)
}

func TestMissingSessionReturnsEmpty(t *testing.T) {
	t.Setenv("MUSE_SESSIONS_DIR", t.TempDir())
	if calls := HarvestCalls("no-such-session"); len(calls) != 0 {
		t.Fatalf("calls = %v", calls)
	}
}

func TestOutOfOrderLogParsesLikeOrdered(t *testing.T) {
	orderedCalls, orderedTL := LiveCallsFromRecords(records(t, "session-retry.jsonl"))
	shuffledCalls, shuffledTL := LiveCallsFromRecords(records(t, "session-out-of-order.jsonl"))
	if !reflect.DeepEqual(shuffledCalls, orderedCalls) {
		t.Errorf("calls differ\nshuffled: %+v\nordered: %+v", shuffledCalls, orderedCalls)
	}
	if !reflect.DeepEqual(shuffledTL, orderedTL) {
		t.Errorf("timelines differ\nshuffled: %+v\nordered: %+v", shuffledTL, orderedTL)
	}
	for _, row := range shuffledTL[:len(shuffledTL)-1] {
		if row.DurationMS == nil || *row.DurationMS < 0 {
			t.Errorf("duration = %v", row.DurationMS)
		}
	}
	if shuffledTL[len(shuffledTL)-1].DurationMS != nil {
		t.Error("last step duration must stay nil, not 0")
	}
}

func TestMetadataVersionFromBuildField(t *testing.T) {
	meta := SessionMetadata(records(t, "session-turns.jsonl"))
	if meta.Model == nil || *meta.Model != "fake-model-1" ||
		meta.Provider == nil || *meta.Provider != "fake-provider" ||
		meta.Version == nil || *meta.Version != "0.0.0-test" {
		t.Fatalf("meta = %+v", meta)
	}
}

func checkSplit(t *testing.T, got Split, model, tool, approval, muse *float64) {
	t.Helper()
	pairs := []struct {
		label string
		got   *float64
		want  *float64
	}{{"model", got.ModelMS, model}, {"tool", got.ToolMS, tool},
		{"approval", got.ApprovalMS, approval}, {"muse", got.MuseMS, muse}}
	for _, p := range pairs {
		if p.want == nil {
			isNilF(t, p.label, p.got)
		} else {
			eqF(t, p.label, p.got, *p.want)
		}
	}
}

func f64(v float64) *float64 { return &v }

func TestTurnBoundariesAndSplitExcludeThinkTime(t *testing.T) {
	turns := SplitTurns(records(t, "session-turns.jsonl"))
	if len(turns) != 2 {
		t.Fatalf("turns = %d", len(turns))
	}
	if turns[0].Prompt != "fake prompt one" || turns[1].Prompt != "fake prompt two" {
		t.Fatalf("prompts = %q, %q", turns[0].Prompt, turns[1].Prompt)
	}
	if turns[0].WallMS != 7300 {
		t.Errorf("turn 1 wall = %d", turns[0].WallMS)
	}
	checkSplit(t, turns[0].Split, f64(5000), f64(1500), f64(500), f64(300))
	if turns[1].WallMS != 5200 {
		t.Errorf("turn 2 wall = %d", turns[1].WallMS)
	}
	checkSplit(t, turns[1].Split, f64(5000), f64(0), f64(0), f64(200))
	if turns[0].Version == nil || *turns[0].Version != "0.0.0-test" {
		t.Errorf("version = %v", turns[0].Version)
	}
}

func blankDurations(node any) {
	switch n := node.(type) {
	case map[string]any:
		for k, v := range n {
			if k == "duration_ms" {
				n[k] = nil
			} else {
				blankDurations(v)
			}
		}
	case []any:
		for _, v := range n {
			blankDurations(v)
		}
	}
}

func TestMissingDurationMakesTurnModelAndMuseNone(t *testing.T) {
	recs := records(t, "session-turns.jsonl")
	for _, r := range recs {
		blankDurations(map[string]any(r))
	}
	turns := SplitTurns(recs)
	if len(turns) != 2 {
		t.Fatalf("turns = %d", len(turns))
	}
	isNilF(t, "model", turns[0].Split.ModelMS)
	isNilF(t, "muse", turns[0].Split.MuseMS)
}

func TestCallStartedBeforeTurnMakesModelTimeUnknown(t *testing.T) {
	recs := records(t, "session-turns.jsonl")
	turns := SplitTurns(recs)
	if turns[0].CallsStartedBeforeTurn != 0 || turns[1].CallsStartedBeforeTurn != 0 {
		t.Fatalf("early = %d, %d", turns[0].CallsStartedBeforeTurn, turns[1].CallsStartedBeforeTurn)
	}
	// Turn 2 opens at 60.1 s. Its call lands at 65.3 s. At 9 s
	// long it started at 56.3 s, inside turn 1.
	payload, _ := asMap(recs[10]["payload"])
	event, _ := asMap(payload["event"])
	event["duration_ms"] = json.Number("9000")
	turns = SplitTurns(recs)
	if turns[1].CallsStartedBeforeTurn != 1 {
		t.Fatalf("turn 2 early = %d", turns[1].CallsStartedBeforeTurn)
	}
	isNilF(t, "turn2 model", turns[1].Split.ModelMS)
	isNilF(t, "turn2 muse", turns[1].Split.MuseMS)
	if turns[0].CallsStartedBeforeTurn != 0 {
		t.Fatalf("turn 1 early = %d", turns[0].CallsStartedBeforeTurn)
	}
	eqF(t, "turn1 model", turns[0].Split.ModelMS, 5000)
}

func TestMissingPairShowsDashNeverAnEstimate(t *testing.T) {
	turns := SplitTurns(records(t, "session-missing-pair.jsonl"))
	if len(turns) != 1 {
		t.Fatalf("turns = %d", len(turns))
	}
	isNilF(t, "tool", turns[0].Split.ToolMS)
	eqF(t, "approval", turns[0].Split.ApprovalMS, 0)
	isNilF(t, "muse", turns[0].Split.MuseMS)
	// A live (not ended) trailing turn is held back.
	if got := SplitTurns(records(t, "session-approval.jsonl")); len(got) != 0 {
		t.Fatalf("live turns = %v", got)
	}
}

func strVal(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func TestLiveStateFromLog(t *testing.T) {
	turns := records(t, "session-turns.jsonl")
	cases := []struct {
		recs  []Record
		state string
		tool  *string
	}{
		{[]Record{}, "idle", nil},
		{turns[:3], "model call running", nil},
		{turns[:5], "tool running", f64str("FakeTool")},
		{turns, "ended", nil},
		{records(t, "session-approval.jsonl"), "waiting for approval", f64str("FakeTool")},
	}
	for i, c := range cases {
		got := LiveState(c.recs)
		if got.State != c.state || strVal(got.Tool) != strVal(c.tool) {
			t.Errorf("case %d: got %+v want %s/%s", i, got, c.state, strVal(c.tool))
		}
	}
}

func f64str(s string) *string { return &s }

func TestInputTraces(t *testing.T) {
	traces := InputTraces(records(t, "session-xray.jsonl"))
	if len(traces) != 2 {
		t.Fatalf("traces = %d", len(traces))
	}
	for i, want := range []float64{0, 1} {
		if step, ok := anyNum(traces[i].Step); !ok || step != want {
			t.Errorf("step %d = %v", i, traces[i].Step)
		}
	}
	if v, _ := anyNum(traces[0].TotalBytes); v != 1000 {
		t.Errorf("total = %v", traces[0].TotalBytes)
	}
	if v, _ := anyNum(traces[0].UserBytes); v != 10 {
		t.Errorf("user = %v", traces[0].UserBytes)
	}
	lane := traces[0].Lanes[0]
	if lane.Lane != "system_base" || lane.Source != "fake_default" || lane.Wire != "option:fake.instructions" {
		t.Errorf("lane = %+v", lane)
	}
	if v, _ := anyNum(lane.Bytes); v != 600 {
		t.Errorf("lane bytes = %v", lane.Bytes)
	}
	if v, _ := anyNum(traces[0].Lanes[3].Bytes); v != 0 {
		t.Errorf("zero-byte group must stay, got %v", traces[0].Lanes[3].Bytes)
	}
	if v, _ := anyNum(traces[1].OmittedGroups); v != 1 {
		t.Errorf("omitted groups = %v", traces[1].OmittedGroups)
	}
	if v, _ := anyNum(traces[1].OmittedBytes); v != 50 {
		t.Errorf("omitted bytes = %v", traces[1].OmittedBytes)
	}
	if v, _ := anyNum(traces[1].Lanes[2].LaneCount); v != 3 {
		t.Errorf("lane count = %v", traces[1].Lanes[2].LaneCount)
	}
	if got := InputTraces(records(t, "session-turns.jsonl")); len(got) != 0 {
		t.Errorf("absent traces must be empty, got %v", got)
	}
	if got := InputTraces(nil); len(got) != 0 {
		t.Errorf("nil records must be empty, got %v", got)
	}
}

func TestToolIntervalsNamedNestedAndTimed(t *testing.T) {
	out := ToolIntervals(records(t, "session-turns.jsonl"))
	if len(out.UnclosedTools) != 0 || len(out.UnclosedApprovals) != 0 {
		t.Fatalf("unclosed = %v/%v", out.UnclosedTools, out.UnclosedApprovals)
	}
	if len(out.Intervals) != 2 {
		t.Fatalf("intervals = %d", len(out.Intervals))
	}
	var tool, appr *Interval
	for i := range out.Intervals {
		switch out.Intervals[i].Kind {
		case "tool":
			tool = &out.Intervals[i]
		case "approval":
			appr = &out.Intervals[i]
		}
	}
	if tool == nil || appr == nil {
		t.Fatalf("intervals = %+v", out.Intervals)
	}
	if strVal(tool.Name) != "FakeTool" || tool.DurationMS != 2000 {
		t.Errorf("tool = %+v", tool)
	}
	eqF(t, "tool wait", tool.WaitMS, 500)
	if strVal(appr.Name) != "FakeTool" || appr.DurationMS != 500 {
		t.Errorf("approval = %+v", appr)
	}
	eqF(t, "approval wait", appr.WaitMS, 0)
	if !(tool.StartAt < appr.StartAt && appr.EndAt < tool.EndAt) {
		t.Errorf("nesting lost: tool %s..%s approval %s..%s",
			tool.StartAt, tool.EndAt, appr.StartAt, appr.EndAt)
	}
}

func TestToolIntervalsUnclosedNeverGetDurations(t *testing.T) {
	out := ToolIntervals(records(t, "session-missing-pair.jsonl"))
	if len(out.Intervals) != 0 || len(out.UnclosedTools) != 1 || strVal(out.UnclosedTools[0]) != "FakeTool" {
		t.Fatalf("out = %+v", out)
	}
	out = ToolIntervals(records(t, "session-approval.jsonl"))
	if len(out.UnclosedTools) != 1 || len(out.UnclosedApprovals) != 1 {
		t.Fatalf("out = %+v", out)
	}
	empty := ToolIntervals(nil)
	if len(empty.Intervals) != 0 || len(empty.UnclosedTools) != 0 || len(empty.UnclosedApprovals) != 0 {
		t.Fatalf("empty = %+v", empty)
	}
	// Empty lists marshal as [], never null.
	body, _ := json.Marshal(empty)
	if !bytes.Contains(body, []byte(`"intervals":[]`)) {
		t.Errorf("empty intervals JSON = %s", body)
	}
}

func TestRetryParsingAndNoRetryCase(t *testing.T) {
	calls := CallsFromRecords(records(t, "session-retry.jsonl"))
	if len(calls) != 2 {
		t.Fatalf("calls = %d", len(calls))
	}
	eqF(t, "duration", calls[0].DurationMS, 11000)
	if calls[0].Retries != 1 {
		t.Errorf("retries = %d", calls[0].Retries)
	}
	eqI(t, "stalled", calls[0].StalledMS, 5000)
	if calls[1].Retries != 0 || calls[1].StalledMS != nil {
		t.Errorf("clean call = %+v", calls[1])
	}
	for _, c := range CallsFromRecords(records(t, "session-turns.jsonl")) {
		if c.Retries != 0 || c.StalledMS != nil {
			t.Errorf("turns call carries retry data: %+v", c)
		}
	}
	recs := records(t, "session-retry.jsonl")
	state := LiveState(recs[:4])
	if state.State != "retrying connection" || state.Tool != nil ||
		state.Attempt == nil || *state.Attempt != "2/10" {
		t.Errorf("mid-retry state = %+v", state)
	}
	calls, timeline := LiveCallsFromRecords(records(t, "session-retry.jsonl"))
	if len(calls) != 2 || calls[0].Retries != 1 || len(timeline) == 0 {
		t.Errorf("live calls = %+v timeline=%d", calls, len(timeline))
	}
	eqI(t, "live stalled", calls[0].StalledMS, 5000)
}

func rec(t *testing.T, line string) Record {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader([]byte(line)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatal(err)
	}
	return Record(m)
}

func TestTwoNodesInOneRecordAlignRetriesByRecord(t *testing.T) {
	status := func(at int, msg string) Record {
		return rec(t, `{"recorded_at":`+itoa(at*1000)+`,"payload":{"event":{"kind":"status","message":`+strconvQuote(msg)+`}}}`)
	}
	node := func(duration, input int) string {
		return `{"kind":"model_completed","duration_ms":` + itoa(duration) +
			`,"usage":{"input_tokens":` + itoa(input) +
			`,"output_tokens":1,"cached_tokens":0,"reasoning_tokens":0}}`
	}
	recs := []Record{
		rec(t, `{"payload":{"event":{"kind":"model_request_configured"}}}`),
		status(2000, "opening meta model stream attempt 1/10"),
		status(3000, "retrying meta model stream in 1000ms (attempt 2/10)"),
		status(8000, "opening meta model stream attempt 2/10"),
		rec(t, `{"payload":{"event":{"kind":"model_completed"},"nodes":[`+node(100, 10)+`,`+node(200, 20)+`]}}`),
		rec(t, `{"payload":{"event":{"kind":"model_request_configured"}}}`),
		rec(t, `{"payload":{"event":{"kind":"model_completed"},"nodes":[`+node(300, 30)+`]}}`),
	}
	calls := CallsFromRecords(recs)
	if len(calls) != 3 {
		t.Fatalf("calls = %d (%+v)", len(calls), calls)
	}
	if calls[0].Retries != 1 {
		t.Errorf("first node retries = %d", calls[0].Retries)
	}
	eqI(t, "first stalled", calls[0].StalledMS, 5000)
	for i := 1; i < 3; i++ {
		if calls[i].Retries != 0 || calls[i].StalledMS != nil {
			t.Errorf("call %d must not inherit the retry: %+v", i, calls[i])
		}
	}
	infos := RetryInfos(recs)
	if len(infos) != 3 || infos[0].Retries != 1 || infos[1].Retries != 0 || infos[2].StalledMS != nil {
		t.Errorf("infos = %+v", infos)
	}
	eqI(t, "info stalled", infos[0].StalledMS, 5000)
}

func itoa(v int) string { return strconv.Itoa(v) }

func intToStr(v int) string { return strconv.Itoa(v) }

func strconvQuote(s string) string { return strconv.Quote(s) }

func effect(ms int, kind, identity string, approval bool) Record {
	prefix := "tool_batch"
	idKey := "effect_id"
	if approval {
		prefix = "approval_wait"
		idKey = "pending_action_id"
	}
	m := map[string]any{
		"recorded_at":  json.Number(intToStr(ms * 1000)),
		"payload_type": prefix + ".effect." + kind,
		"payload":      map[string]any{"record": map[string]any{idKey: identity}},
	}
	return Record(m)
}

func TestTimeSplitUnionsToolsAndApprovals(t *testing.T) {
	recs := []Record{
		effect(0, "started", "a", false), effect(0, "started", "b", false),
		effect(200, "started", "c", true), effect(300, "started", "d", true),
		effect(700, "terminal", "c", true), effect(800, "terminal", "d", true),
		effect(1000, "terminal", "a", false), effect(1000, "terminal", "b", false),
	}
	checkSplit(t, TimeSplit(recs, f64(1000), f64(0)), f64(0), f64(400), f64(600), f64(0))
}

func TestInconsistentTimeSplitDoesNotInventZeroOverhead(t *testing.T) {
	isNilF(t, "muse", TimeSplit(nil, f64(100), f64(200)).MuseMS)
}

func TestImportRequiresExplicitOutcome(t *testing.T) {
	recs := records(t, "session-turns.jsonl")
	turns := SplitTurns(recs)
	if turns[0].Status != "unknown" || turns[1].Status != "unknown" {
		t.Fatalf("statuses = %s, %s", turns[0].Status, turns[1].Status)
	}
	terminals := records(t, "session-terminal-outcomes.jsonl")
	wants := []string{"completed", "interrupted", "failed"}
	for i, terminal := range terminals {
		withTerminal := append(append([]Record(nil), recs[:len(recs)-1]...),
			terminal, recs[len(recs)-1])
		turns := SplitTurns(withTerminal)
		if len(turns) != 2 || turns[0].Status != "unknown" || turns[1].Status != wants[i] {
			t.Errorf("terminal %d: turns = %+v", i, turns)
		}
	}
}
