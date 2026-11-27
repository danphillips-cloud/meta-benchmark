package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeIndex(t *testing.T, lines ...string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.jsonl"),
		[]byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

const runA = `{"run_id":"r1","at":"2026-11-01T00:00:00+00:00","status":"running","provider":"meta","calls":[]}`
const runADone = `{"run_id":"r1","at":"2026-11-01T00:00:00+00:00","status":"completed","provider":"meta","model":"m1","wall_ms":1000,"exit_code":0,"prompt":"hi","reply":"yo","calls":[{"duration_ms":400,"input_tokens":10,"output_tokens":5},{"duration_ms":600,"input_tokens":20,"output_tokens":7}]}`

func TestLoadRunsKeepsLastPerRunID(t *testing.T) {
	h := &handler{dataDir: writeIndex(t, runA, runADone)}
	runs := h.loadRuns()
	if len(runs) != 1 {
		t.Fatalf("want 1 deduped run, got %d", len(runs))
	}
	if got := getStr(runs[0], "status"); got != "completed" {
		t.Fatalf("want last entry to win, got status %q", got)
	}
}

func TestReadLogsShapeAndStrictTokens(t *testing.T) {
	h := &handler{dataDir: writeIndex(t, runA, runADone)}
	logs := h.readLogs("")
	if logs["selected"] != "r1" {
		t.Fatalf("selected = %v", logs["selected"])
	}
	sessions := logs["sessions"].([]any)
	if len(sessions) != 1 {
		t.Fatalf("sessions = %d", len(sessions))
	}
	row := sessions[0].(map[string]any)
	if row["input_tokens"] != float64(30) || row["output_tokens"] != float64(12) {
		t.Fatalf("tokens = %v/%v", row["input_tokens"], row["output_tokens"])
	}
	if row["model_ms"] != float64(1000) {
		t.Fatalf("model_ms = %v", row["model_ms"])
	}
	if len(logs["events"].([]any)) != 2 {
		t.Fatalf("events = %v", logs["events"])
	}
}

// A missing measurement stays null. It never becomes a zero.
func TestMissingTokensStayNull(t *testing.T) {
	line := `{"run_id":"r2","status":"completed","provider":"meta","calls":[{"duration_ms":100,"output_tokens":3}]}`
	h := &handler{dataDir: writeIndex(t, line)}
	row := h.readLogs("")["sessions"].([]any)[0].(map[string]any)
	if row["input_tokens"] != nil {
		t.Fatalf("input_tokens = %v, want nil", row["input_tokens"])
	}
	body, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"input_tokens":null`) {
		t.Fatalf("want null in JSON, got %s", body)
	}
}

func TestHandlerReadOnlyAndLocalOnly(t *testing.T) {
	h := &handler{dataDir: writeIndex(t, runADone), port: 9999}
	cases := []struct {
		name, method, path, host string
		want                     int
	}{
		{"logs ok", "GET", "/api/logs", "127.0.0.1:9999", 200},
		{"shell ok", "GET", "/", "localhost:9999", 200},
		{"deep link ok", "GET", "/runs/r1", "127.0.0.1:9999", 200},
		{"delete absent", "POST", "/api/delete", "127.0.0.1:9999", 404},
		{"unknown api", "GET", "/api/nope", "127.0.0.1:9999", 404},
		{"foreign host", "GET", "/api/logs", "evil.example.com", 403},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, nil)
		req.Host = c.host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s: got %d, want %d", c.name, rec.Code, c.want)
		}
	}
	// The index is untouched by every request above.
	data, err := os.ReadFile(filepath.Join(h.dataDir, "index.jsonl"))
	if err != nil || string(data) != runADone+"\n" {
		t.Fatalf("index changed: %v %q", err, data)
	}
}

func TestUsePort(t *testing.T) {
	cases := []struct {
		env      string
		wantPort int
		wantCode int
	}{
		{"", defaultPort, 0},
		{"0", 0, 0},
		{"8766", 8766, 0},
		{"8765", 0, 2},
		{"abc", 0, 2},
		{"99999", 0, 2},
		{"-1", 0, 2},
	}
	for _, c := range cases {
		t.Setenv("PORT", c.env)
		port, code := usePort()
		if port != c.wantPort || code != c.wantCode {
			t.Errorf("PORT=%q: got (%d,%d), want (%d,%d)", c.env, port, code, c.wantPort, c.wantCode)
		}
		// Reset for the next case. t.Setenv restores at test end,
		// so clear explicitly between iterations.
		os.Unsetenv("PORT")
	}
}
