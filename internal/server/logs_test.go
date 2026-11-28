package server

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// These cases mirror ReadLogsTest, StaleRunningTest,
// LogParsingFixTest and VisibilityTest server cases in
// tests/test_tool.py. The Python tests are the spec.

func fixtureBytes(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func setupSession(t *testing.T, sid, fixture string) {
	t.Helper()
	sessions := t.TempDir()
	writeFile(t, filepath.Join(sessions, sid, "session.jsonl"),
		string(fixtureBytes(t, fixture)))
	t.Setenv("MUSE_SESSIONS_DIR", sessions)
}

func runningRunLine(runID, sid, provider string) string {
	at := time.Now().UTC().Format(time.RFC3339)
	return `{"run_id":"` + runID + `","at":"` + at + `","prompt":"fake prompt","model":"fake-model-1","provider":"` + provider + `","session_id":` + jsonStr(sid) + `,"context_mode":"full","comparison_id":null,"status":"running","timeout_seconds":1800,"wall_ms":null,"exit_code":null,"reply":"","calls":[],"metrics_unavailable":false,"error":null}`
}

func jsonStr(s string) string {
	if s == "" {
		return "null"
	}
	body, _ := json.Marshal(s)
	return string(body)
}

func decodeNumbered(t *testing.T, data []byte) any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestGoldenAPILogs(t *testing.T) {
	t.Setenv("MUSE_SESSIONS_DIR", t.TempDir())
	srv := New(Config{
		DataDir: filepath.Join("..", "..", "testdata", "golden", "runs"),
		WebFS:   testWebFS(),
	})
	got, err := json.Marshal(srv.ReadLogs(""))
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join("..", "..", "testdata", "golden", "api_logs.json"))
	if err != nil {
		t.Fatal(err)
	}
	gotV, wantV := decodeNumbered(t, got), decodeNumbered(t, want)
	if !reflect.DeepEqual(gotV, wantV) {
		gotPretty, _ := json.MarshalIndent(gotV, "", "  ")
		wantPretty, _ := json.MarshalIndent(wantV, "", "  ")
		t.Fatalf("/api/logs differs from the Python golden\nGo:\n%s\nPython golden:\n%s", gotPretty, wantPretty)
	}
}

func TestSelectionScopesEventsAndLoadsTimeline(t *testing.T) {
	dataDir := t.TempDir()
	runA := `{"run_id":"run-a","at":"2026-01-01T00:00:00+00:00","prompt":"first","reply":"1","model":"muse-wonder-full-1.0","provider":"meta","exit_code":0,"error":null,"wall_ms":100,"calls":[{"duration_ms":80,"input_tokens":10,"output_tokens":2}]}`
	runB := `{"run_id":"run-b","at":"2026-01-02T00:00:00+00:00","prompt":"second","reply":"2","model":"muse-wonder-full-1.0","provider":"meta","exit_code":0,"error":null,"wall_ms":200,"calls":[{"duration_ms":150,"input_tokens":20,"output_tokens":3}]}`
	writeFile(t, filepath.Join(dataDir, "run-a", "report.json"),
		`{"run_id":"run-a","timeline":[{"operation":"step-a","duration_ms":5}]}`)
	writeFile(t, filepath.Join(dataDir, "run-b", "report.json"),
		`{"run_id":"run-b","timeline":[{"operation":"step-b","duration_ms":7}]}`)
	writeFile(t, filepath.Join(dataDir, "index.jsonl"), runA+"\n"+runB+"\n")
	srv := New(Config{DataDir: dataDir, WebFS: testWebFS()})
	latest := srv.ReadLogs("")
	if latest["selected"] != "run-b" {
		t.Fatalf("selected = %v", latest["selected"])
	}
	sessions := latest["sessions"].([]any)
	if sessions[0].(map[string]any)["run_id"] != "run-b" ||
		sessions[1].(map[string]any)["run_id"] != "run-a" {
		t.Fatalf("sessions order = %v", sessions)
	}
	picked := srv.ReadLogs("run-a")
	if picked["prompt"] != "first" {
		t.Fatalf("prompt = %v", picked["prompt"])
	}
	event := picked["events"].([]any)[0].(map[string]any)
	if event["wire_ms"] != json.Number("80") {
		t.Errorf("wire = %v", event["wire_ms"])
	}
	row := picked["timeline"].([]any)[0].(map[string]any)
	if row["operation"] != "step-a" {
		t.Errorf("timeline = %v", row)
	}
}

func TestOldRunningWithoutReportIsNotRunning(t *testing.T) {
	dataDir := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "run-old", "keep.txt"), "x")
	run := `{"run_id":"run-old","at":"2020-01-01T00:00:00+00:00","prompt":"stuck","model":"m","provider":"meta","session_id":null,"context_mode":"full","comparison_id":null,"status":"running","timeout_seconds":1800,"wall_ms":null,"exit_code":null,"reply":"","calls":[],"metrics_unavailable":false,"error":null}`
	writeFile(t, filepath.Join(dataDir, "index.jsonl"), run+"\n")
	srv := New(Config{DataDir: dataDir, WebFS: testWebFS()})
	data := srv.ReadLogs("")
	if data["status"] == "running" {
		t.Fatal("stale run must not stay running")
	}
	row := data["sessions"].([]any)[0].(map[string]any)
	if row["status"] != "interrupted" {
		t.Errorf("status = %v", row["status"])
	}
}

func TestNoInventedZerosForMissingModel(t *testing.T) {
	dataDir := t.TempDir()
	// No durations and no api_ms: model time is nil, not 0.
	run := `{"run_id":"run-a","at":"2026-01-01T00:00:00+00:00","prompt":"p","reply":"r","model":"m","provider":"meta","exit_code":0,"error":null,"wall_ms":100,"api_ms":null,"calls":[{"duration_ms":null,"input_tokens":10,"output_tokens":2}]}`
	writeFile(t, filepath.Join(dataDir, "index.jsonl"), run+"\n")
	srv := New(Config{DataDir: dataDir, WebFS: testWebFS()})
	data := srv.ReadLogs("")
	if data["model_ms"] != nil {
		t.Errorf("model_ms = %v, want nil", data["model_ms"])
	}
	row := data["sessions"].([]any)[0].(map[string]any)
	if row["model_ms"] != nil || row["overhead_ms"] != nil {
		t.Errorf("row = %v/%v", row["model_ms"], row["overhead_ms"])
	}
}

func TestLiveStateAndSplitForRunningRun(t *testing.T) {
	dataDir := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "run-live", "keep.txt"), "x")
	writeFile(t, filepath.Join(dataDir, "index.jsonl"),
		runningRunLine("run-live", "fake-session-1", "meta")+"\n")
	setupSession(t, "fake-session-1", "session-approval.jsonl")
	srv := New(Config{DataDir: dataDir, WebFS: testWebFS()})
	data := srv.ReadLogs("run-live")
	body, _ := json.Marshal(data["live_state"])
	if string(body) != `{"state":"waiting for approval","tool":"FakeTool"}` {
		t.Errorf("live_state = %s", body)
	}
	split := data["time_split"].(map[string]any)
	if split["approval_ms"] != nil || split["muse_ms"] != nil {
		t.Errorf("split = %v", split)
	}
	if data["elapsed_ms"] == nil {
		t.Error("running run must carry elapsed_ms")
	}
	// No model call has completed in this fixture yet. Python
	// reports the same zero. Nothing is invented to fill it.
	row := data["sessions"].([]any)[0].(map[string]any)
	if row["calls"] != 0 {
		t.Errorf("calls in row = %v, want the recorded 0", row["calls"])
	}
}

func TestLiveRetryFieldsAndRetryingState(t *testing.T) {
	dataDir := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "run-live", "keep.txt"), "x")
	writeFile(t, filepath.Join(dataDir, "index.jsonl"),
		runningRunLine("run-live", "fake-session-retry", "meta")+"\n")
	setupSession(t, "fake-session-retry", "session-retry.jsonl")
	srv := New(Config{DataDir: dataDir, WebFS: testWebFS()})
	data := srv.ReadLogs("run-live")
	events := data["events"].([]any)
	if len(events) != 2 {
		t.Fatalf("events = %d", len(events))
	}
	// Events are newest first. The retried call is the older one.
	older := events[1].(map[string]any)
	if older["retries"] != 1 {
		t.Errorf("retries = %v", older["retries"])
	}
	if stalled, ok := num(older["stalled_ms"]); !ok || stalled != 5000 {
		t.Errorf("stalled = %v", older["stalled_ms"])
	}
	// The running run shows its landed calls before it finishes.
	row := data["sessions"].([]any)[0].(map[string]any)
	if row["calls"] != 2 {
		t.Errorf("live calls in row = %v", row["calls"])
	}
}

func TestXrayAndIntervalsFromSessionLog(t *testing.T) {
	dataDir := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "run-xray", "keep.txt"), "x")
	run := strings.Replace(runningRunLine("run-xray", "fake-session-xray", "meta"),
		`"status":"running"`, `"status":"completed","wall_ms":10000,"exit_code":0`, 1)
	writeFile(t, filepath.Join(dataDir, "index.jsonl"), run+"\n")
	setupSession(t, "fake-session-xray", "session-xray.jsonl")
	srv := New(Config{DataDir: dataDir, WebFS: testWebFS()})
	data := srv.ReadLogs("run-xray")
	body, _ := json.Marshal(data["xray"])
	var traces []map[string]any
	if err := json.Unmarshal(body, &traces); err != nil {
		t.Fatal(err)
	}
	if len(traces) != 2 || traces[0]["total_bytes"] != float64(1000) || traces[1]["total_bytes"] != float64(1250) {
		t.Errorf("xray = %s", body)
	}
}

func TestDeletedLogStillAnswers(t *testing.T) {
	dataDir := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "run-live", "keep.txt"), "x")
	writeFile(t, filepath.Join(dataDir, "index.jsonl"),
		runningRunLine("run-live", "fake-session-del", "meta")+"\n")
	sessions := t.TempDir()
	logPath := filepath.Join(sessions, "fake-session-del", "session.jsonl")
	writeFile(t, logPath, string(fixtureBytes(t, "session-retry.jsonl")))
	t.Setenv("MUSE_SESSIONS_DIR", sessions)
	srv, ts := newTestServer(t, dataDir)
	if got := srv.ReadLogs("run-live")["selected"]; got != "run-live" {
		t.Fatalf("primed selected = %v", got)
	}
	if err := os.Remove(logPath); err != nil {
		t.Fatal(err)
	}
	after := srv.ReadLogs("run-live")
	if len(after["sessions"].([]any)) != 1 {
		t.Fatal("sessions must survive a deleted log")
	}
	code, _, body := doReq(t, ts, "GET", "/api/logs", localHost(ts), "")
	if code != 200 || !strings.Contains(string(body), `"selected":"run-live"`) &&
		!strings.Contains(string(body), `"selected": "run-live"`) {
		var parsed map[string]any
		_ = json.Unmarshal(body, &parsed)
		if code != 200 || parsed["selected"] != "run-live" {
			t.Errorf("after delete: %d %s", code, body)
		}
	}
}

func TestClaudeLiveFromEventsFileAndCacheInvalidation(t *testing.T) {
	dataDir := t.TempDir()
	eventsPath := filepath.Join(dataDir, "run-mid-tool", "events.jsonl")
	lines := strings.Split(strings.TrimRight(string(fixtureBytes(t, "claude-code-stream.jsonl")), "\n"), "\n")
	writeFile(t, eventsPath, strings.Join(lines[:3], "\n")+"\n")
	run := `{"run_id":"run-mid-tool","at":"` + time.Now().UTC().Format(time.RFC3339) +
		`","prompt":"fake prompt","model":"fake-model-1","provider":"claude-code","status":"running","session_id":null,"exit_code":null,"error":null,"reply":"","wall_ms":null,"timeout_seconds":999999,"calls":[]}`
	writeFile(t, filepath.Join(dataDir, "index.jsonl"), run+"\n")
	t.Setenv("MUSE_SESSIONS_DIR", t.TempDir())
	srv := New(Config{DataDir: dataDir, WebFS: testWebFS()})
	data := srv.ReadLogs("run-mid-tool")
	body, _ := json.Marshal(data["live_state"])
	if string(body) != `{"state":"tool running","tool":"Bash"}` {
		t.Fatalf("live_state = %s", body)
	}
	// A second read with an unchanged file serves the same data.
	again := srv.ReadLogs("run-mid-tool")
	if again["live_state"] == nil {
		t.Fatal("cached read lost live state")
	}
	// Appending a line changes the stamp, so the next read sees
	// the tool result and the model running again.
	writeFile(t, eventsPath, strings.Join(lines[:4], "\n")+"\n")
	moved := srv.ReadLogs("run-mid-tool")
	body, _ = json.Marshal(moved["live_state"])
	var state map[string]any
	_ = json.Unmarshal(body, &state)
	if state["state"] != "model call running" {
		t.Errorf("after append = %s", body)
	}
	if len(moved["events"].([]any)) != 1 {
		t.Errorf("claude live calls = %v", moved["events"])
	}
}
