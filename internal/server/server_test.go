package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

// These cases mirror the server tests in tests/test_tool.py
// (HostCheckTest, StaticFilesTest, PortHeldTest, DeleteRunTest).
// The Python tests are the spec.

func testWebFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html": {Data: []byte("<html>shell</html>")},
		"app.js":     {Data: []byte("console.log(1)")},
		"style.css":  {Data: []byte("body{}")},
	}
}

func newTestServer(t *testing.T, dataDir string) (*Server, *httptest.Server) {
	t.Helper()
	srv := New(Config{DataDir: dataDir, WebFS: testWebFS()})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	port, err := strconv.Atoi(ts.URL[strings.LastIndex(ts.URL, ":")+1:])
	if err != nil {
		t.Fatal(err)
	}
	srv.SetPort(port)
	return srv, ts
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func doReq(t *testing.T, ts *httptest.Server, method, path string, headers map[string]string, body string) (int, string, []byte) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, ts.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		if k == "Host" {
			req.Host = v
		} else {
			req.Header.Set(k, v)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header.Get("Content-Type"), data
}

func localHost(ts *httptest.Server) map[string]string {
	return map[string]string{"Host": strings.TrimPrefix(ts.URL, "http://")}
}

func TestCrossSiteAndRebindingRequestsRejected(t *testing.T) {
	_, ts := newTestServer(t, t.TempDir())
	port := ts.URL[strings.LastIndex(ts.URL, ":")+1:]
	cases := []struct {
		headers map[string]string
		want    int
	}{
		{map[string]string{"Host": "127.0.0.1:" + port}, 200},
		{map[string]string{"Host": "localhost:" + port}, 200},
		{map[string]string{"Host": "evil.example"}, 403},
		{map[string]string{"Host": "127.0.0.1:" + port, "Origin": "https://evil.example"}, 403},
	}
	for i, c := range cases {
		if code, _, _ := doReq(t, ts, "GET", "/api/logs", c.headers, ""); code != c.want {
			t.Errorf("case %d: got %d want %d", i, code, c.want)
		}
	}
	code, _, _ := doReq(t, ts, "POST", "/api/delete", map[string]string{
		"Host": "127.0.0.1:" + port, "Origin": "https://evil.example",
		"Content-Type": "application/json"}, `{"run_id":"x"}`)
	if code != 403 {
		t.Errorf("cross-site delete = %d, want 403", code)
	}
}

func TestStaticFilesAndSPAFallback(t *testing.T) {
	_, ts := newTestServer(t, t.TempDir())
	for _, path := range []string{"/", "/index.html", "/runs/20260101-abc",
		"/compare/set1", "/timeline/run-a", "/some/deep/link"} {
		code, ctype, body := doReq(t, ts, "GET", path, localHost(ts), "")
		if code != 200 || !strings.Contains(ctype, "text/html") || string(body) != "<html>shell</html>" {
			t.Errorf("%s: %d %q %q", path, code, ctype, body)
		}
	}
	code, ctype, body := doReq(t, ts, "GET", "/app.js", localHost(ts), "")
	if code != 200 || !strings.Contains(ctype, "javascript") || string(body) != "console.log(1)" {
		t.Errorf("app.js: %d %q %q", code, ctype, body)
	}
	code, ctype, body = doReq(t, ts, "GET", "/style.css", localHost(ts), "")
	if code != 200 || !strings.Contains(ctype, "text/css") || string(body) != "body{}" {
		t.Errorf("style.css: %d %q %q", code, ctype, body)
	}
	code, ctype, body = doReq(t, ts, "GET", "/api/logs", localHost(ts), "")
	if code != 200 || !strings.Contains(ctype, "application/json") || !strings.Contains(string(body), `"sessions"`) {
		t.Errorf("api/logs: %d %q %q", code, ctype, body)
	}
	if code, _, _ := doReq(t, ts, "GET", "/api/nope", localHost(ts), ""); code != 404 {
		t.Errorf("unknown api = %d", code)
	}
	if code, _, _ := doReq(t, ts, "GET", "/app.js", map[string]string{"Host": "evil.example"}, ""); code != 403 {
		t.Errorf("foreign host = %d", code)
	}
}

func TestParsePort(t *testing.T) {
	if port, msg := ParsePort("9999"); port != 9999 || msg != "" {
		t.Errorf("good port = %d %q", port, msg)
	}
	if port, msg := ParsePort(" 8766 "); port != 8766 || msg != "" {
		t.Errorf("padded port = %d %q", port, msg)
	}
	for _, bad := range []string{"abc", "", "99999", "-1", "65536", "1.5"} {
		port, msg := ParsePort(bad)
		if port != 0 || !strings.Contains(msg, "PORT must be a whole number") {
			t.Errorf("PORT=%q: got %d %q", bad, port, msg)
		}
	}
	// The message names the raw value.
	if _, msg := ParsePort("abc"); msg != `PORT must be a whole number, got "abc"` {
		t.Errorf("message = %q", msg)
	}
}

func TestUsePortFromEnv(t *testing.T) {
	os.Unsetenv("PORT")
	if port, msg := UsePort(); port != 8765 || msg != "" {
		t.Errorf("unset = %d %q, want the 8765 contract default", port, msg)
	}
	t.Setenv("PORT", "9999")
	if port, msg := UsePort(); port != 9999 || msg != "" {
		t.Errorf("set = %d %q", port, msg)
	}
	t.Setenv("PORT", "abc")
	if _, msg := UsePort(); !strings.Contains(msg, "PORT must be a whole number") {
		t.Errorf("bad = %q", msg)
	}
	t.Setenv("PORT", "")
	if _, msg := UsePort(); msg == "" {
		t.Error("explicitly empty PORT must be a startup error like Python")
	}
}

func TestDeleteOverHTTP(t *testing.T) {
	dataDir := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "run-done", "report.json"), "{}")
	writeFile(t, filepath.Join(dataDir, "index.jsonl"),
		`{"run_id":"run-done","status":"completed"}`+"\n")
	_, ts := newTestServer(t, dataDir)
	code, _, body := doReq(t, ts, "POST", "/api/delete", localHost(ts), `{"run_id":"run-done"}`)
	if code != 200 {
		t.Fatalf("delete = %d %s", code, body)
	}
	var result map[string]any
	if err := json.Unmarshal(body, &result); err != nil || result["ok"] != true || result["reason"] != nil {
		t.Errorf("result = %s", body)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "run-done")); !os.IsNotExist(err) {
		t.Error("run dir must be gone")
	}
	// Unknown POST route and oversized body.
	if code, _, _ := doReq(t, ts, "POST", "/api/nope", localHost(ts), "{}"); code != 404 {
		t.Errorf("unknown POST = %d", code)
	}
	code, _, body = doReq(t, ts, "POST", "/api/delete", localHost(ts), `{"run_id":"bad/id"}`)
	if code != 400 || !strings.Contains(string(body), "invalid run id") {
		t.Errorf("bad id = %d %s", code, body)
	}
	big := `{"run_id":"` + strings.Repeat("a", MaxBody) + `"}`
	if code, _, _ := doReq(t, ts, "POST", "/api/delete", localHost(ts), big); code != 400 {
		t.Errorf("oversized body = %d, want 400", code)
	}
}

func TestDeleteRefusesRunningAndAllowsStale(t *testing.T) {
	dataDir := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "run-live", "keep.txt"), "x")
	writeFile(t, filepath.Join(dataDir, "run-done", "keep.txt"), "x")
	writeFile(t, filepath.Join(dataDir, "run-crashed", "keep.txt"), "x")
	writeFile(t, filepath.Join(dataDir, "index.jsonl"), strings.Join([]string{
		`{"run_id":"run-live","status":"running","at":"2999-01-01T00:00:00+00:00","timeout_seconds":1800}`,
		`{"run_id":"run-done","status":"completed"}`,
		`{"run_id":"run-crashed","status":"running","at":"2020-01-01T00:00:00+00:00","timeout_seconds":60}`,
	}, "\n")+"\n")
	srv := New(Config{DataDir: dataDir, WebFS: testWebFS()})
	if ok, reason := srv.DeleteRun("run-live"); ok || !strings.Contains(reason, "running") {
		t.Fatalf("live delete = %v %q", ok, reason)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "run-live")); err != nil {
		t.Error("live run dir must survive")
	}
	if ok, reason := srv.DeleteRun("run-done"); !ok {
		t.Fatalf("done delete refused: %s", reason)
	}
	// A crashed run stays "running" in the index forever. The
	// page shows it as interrupted, so it must be deletable.
	if ok, reason := srv.DeleteRun("run-crashed"); !ok {
		t.Fatalf("crashed delete refused: %s", reason)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "run-crashed")); !os.IsNotExist(err) {
		t.Error("crashed run dir must be gone")
	}
	kept, _ := os.ReadFile(filepath.Join(dataDir, "index.jsonl"))
	if strings.Contains(string(kept), "run-done") || strings.Contains(string(kept), "run-crashed") ||
		!strings.Contains(string(kept), "run-live") {
		t.Errorf("index after deletes = %q", kept)
	}
}

func TestDeletePreservesIndexFileModeAndCreatesLockFile(t *testing.T) {
	dataDir := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "run-done", "keep.txt"), "x")
	index := filepath.Join(dataDir, "index.jsonl")
	writeFile(t, index, `{"run_id":"run-done","status":"completed"}`+"\n")
	if err := os.Chmod(index, 0o640); err != nil {
		t.Fatal(err)
	}
	srv := New(Config{DataDir: dataDir, WebFS: testWebFS()})
	if ok, reason := srv.DeleteRun("run-done"); !ok {
		t.Fatalf("delete refused: %s", reason)
	}
	info, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Errorf("mode = %o, want 640", info.Mode().Perm())
	}
	// The lock file is the same one Python writers flock, and
	// it is never deleted.
	if _, err := os.Stat(index + ".lock"); err != nil {
		t.Errorf("lock file missing: %v", err)
	}
}
