package runner

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Provider tests use fakes only. No paid run ever happens here.

func TestRunAnthropicRecordsCallAndTotals(t *testing.T) {
	hits := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Header.Get("x-api-key") != "test-key" || r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Errorf("headers = %v", r.Header)
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"max_tokens":8192`) {
			t.Errorf("body = %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"claude-x","stop_reason":"end_turn",` +
			`"content":[{"type":"text","text":"pon"},{"type":"text","text":"g"}],` +
			`"usage":{"input_tokens":100,"cache_read_input_tokens":30,` +
			`"cache_creation_input_tokens":10,"output_tokens":7}}`))
	}))
	defer ts.Close()
	t.Setenv("ANTHROPIC_BASE_URL", ts.URL)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	runDir := t.TempDir()
	result := RunAnthropic(context.Background(), "say pong", runDir, "claude-x", 30)
	if hits != 1 || result.ExitCode != 0 || result.Reply != "pong" {
		t.Fatalf("result = %+v hits=%d", result, hits)
	}
	if len(result.Calls) != 1 {
		t.Fatalf("calls = %+v", result.Calls)
	}
	call := result.Calls[0]
	if *call.InputTokens != 140 || *call.FreshInputTokens != 100 ||
		*call.CacheCreationTokens != 10 || !call.CacheCreationPresent ||
		*call.CachedTokens != 30 || *call.OutputTokens != 7 ||
		call.StopReason == nil || *call.StopReason != "end_turn" {
		t.Errorf("call = %+v", call)
	}
	if result.Totals == nil || *result.Totals.Input != 140 || !result.Totals.HasCacheCreation {
		t.Errorf("totals = %+v", result.Totals)
	}
	if len(result.Timeline) != 1 || result.Timeline[0].WireMS == nil {
		t.Errorf("timeline = %+v", result.Timeline)
	}
}

func TestRunAnthropicMissingKeyAndHTTPError(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	result := RunAnthropic(context.Background(), "hi", t.TempDir(), "claude-x", 30)
	if result.ErrorOverride == nil || *result.ErrorOverride != "ANTHROPIC_API_KEY is not set" {
		t.Fatalf("missing key = %+v", result)
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(402)
		_, _ = w.Write([]byte(`{"error":{"message":"Billing verification failed"}}`))
	}))
	defer ts.Close()
	t.Setenv("ANTHROPIC_BASE_URL", ts.URL)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	result = RunAnthropic(context.Background(), "hi", t.TempDir(), "claude-x", 30)
	if result.ExitCode != 402 || result.ErrorOverride == nil ||
		*result.ErrorOverride != "Billing verification failed" || len(result.Calls) != 0 {
		t.Fatalf("http error = %+v", result)
	}
}

func fakeBinary(t *testing.T, name, script string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	return dir
}

func TestRunClaudeCodeWithFakeBinary(t *testing.T) {
	fixture, err := filepath.Abs(filepath.Join("..", "..", "testdata", "fixtures", "claude-code-stream.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	fakeBinary(t, "claude", "cat >/dev/null; cat \""+fixture+"\"\n")
	t.Setenv("MODEL_API_KEY", "test-key")
	runDir := t.TempDir()
	var out strings.Builder
	result := RunClaudeCode(context.Background(), "make hello", runDir,
		"muse-wonder-1.0", 30, "", &out)
	if result.ExitCode != 0 || len(result.Calls) != 2 {
		t.Fatalf("result = exit %d calls %d err %v", result.ExitCode, len(result.Calls), result.ErrorOverride)
	}
	if *result.Calls[0].InputTokens != 1682 || result.Totals == nil || *result.Totals.Input != 3469 {
		t.Errorf("parsed = %+v totals %+v", result.Calls[0], result.Totals)
	}
	if result.Command == nil || !strings.Contains(*result.Command, "--bare") {
		t.Errorf("command = %v", result.Command)
	}
	if !strings.Contains(out.String(), "call 1 · arrived") {
		t.Errorf("live lines missing: %q", out.String())
	}
	// Missing key refuses before the binary runs.
	t.Setenv("MODEL_API_KEY", "")
	result = RunClaudeCode(context.Background(), "hi", t.TempDir(), "muse-wonder-1.0", 30, "", &out)
	if result.ErrorOverride == nil || *result.ErrorOverride != "MODEL_API_KEY is not set" {
		t.Errorf("missing key = %+v", result)
	}
}

func TestCodexBillingModeClassification(t *testing.T) {
	cases := []struct {
		out  string
		err  error
		want string
	}{
		{"Logged in using ChatGPT\n", nil, "subscription"},
		{"Logged in using an API key\n", nil, "api"},
		{"Logged in using an API key - sk-secret\n", nil, "api"},
		{"some other text\n", nil, "unknown"},
		{"", os.ErrNotExist, "unknown"},
	}
	for i, c := range cases {
		got := codexBillingModeWith(func() ([]byte, []byte, error) {
			return []byte(c.out), nil, c.err
		})
		if got != c.want {
			t.Errorf("case %d = %q want %q", i, got, c.want)
		}
	}
	// Key text from an API login line is never echoed back.
	got := codexBillingModeWith(func() ([]byte, []byte, error) {
		return []byte("Logged in using an API key - synthetic-key\n"), nil, nil
	})
	if strings.Contains(got, "synthetic") {
		t.Errorf("billing leaked key text: %q", got)
	}
}

func TestRunCodexWithFakeBinary(t *testing.T) {
	fixture, err := filepath.Abs(filepath.Join("..", "..", "testdata", "fixtures", "codex-exec-captured.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	script := `if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi
cat >/dev/null; cat "` + fixture + `"
`
	fakeBinary(t, "codex", script)
	runDir := t.TempDir()
	result := RunCodex(context.Background(), "Reply with exactly: pong", runDir,
		"gpt-test", true, 30, io.Discard)
	if result.ExitCode != 0 || result.Reply != "pong" {
		t.Fatalf("result = exit %d reply %q err %v", result.ExitCode, result.Reply, result.ErrorOverride)
	}
	if result.BillingMode == nil || *result.BillingMode != "subscription" {
		t.Errorf("billing = %v", result.BillingMode)
	}
	if result.Totals == nil || *result.Totals.Input != 11640 || len(result.Calls) != 0 {
		t.Errorf("totals = %+v calls = %v", result.Totals, result.Calls)
	}
	if result.Command == nil || !strings.Contains(*result.Command, "--strict-config") {
		t.Errorf("minimal flags missing: %v", result.Command)
	}
}

func TestWSLGuardRefusesWindowsBinary(t *testing.T) {
	oldLook, oldWSL := lookPath, isWSLNow
	defer func() { lookPath, isWSLNow = oldLook, oldWSL }()
	isWSLNow = func() bool { return true }
	lookPath = func(name string) (string, error) {
		return "/mnt/c/Users/test/" + name + ".exe", nil
	}
	msg := guardProviderBinary("claude")
	if !strings.Contains(msg, "Windows binary") || !strings.Contains(msg, "Linux build inside WSL") {
		t.Fatalf("guard = %q", msg)
	}
	lookPath = func(name string) (string, error) { return "/usr/local/bin/" + name, nil }
	if msg := guardProviderBinary("claude"); msg != "" {
		t.Errorf("linux binary must pass, got %q", msg)
	}
	isWSLNow = func() bool { return false }
	lookPath = func(name string) (string, error) { return "/mnt/c/x/claude.exe", nil }
	if msg := guardProviderBinary("claude"); msg != "" {
		t.Errorf("non-WSL must not be guarded, got %q", msg)
	}
}
