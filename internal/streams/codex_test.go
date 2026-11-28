package streams

import (
	"encoding/json"
	"testing"
)

// Mirrors CodexTest in tests/test_tool.py.

func codexEvents(t *testing.T, extra ...map[string]any) []Stamped {
	t.Helper()
	events := []map[string]any{
		{"type": "thread.started", "thread_id": "codex-test-thread"},
		{"type": "turn.started"},
		{"type": "item.completed", "item": map[string]any{
			"type": "command_execution", "id": "tool", "exit_code": 0}},
		{"type": "item.completed", "item": map[string]any{
			"type": "agent_message", "text": "pong"}},
	}
	events = append(events, extra...)
	out := make([]Stamped, 0, len(events))
	for _, e := range events {
		body, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, Stamped{Line: string(body)})
	}
	return out
}

func completion(usage map[string]any) map[string]any {
	return map[string]any{"type": "turn.completed", "usage": usage}
}

func TestCodexCapturedStream(t *testing.T) {
	lines := fixtureLines(t, "codex-exec-captured.jsonl")
	var stamped []Stamped
	for _, line := range lines {
		stamped = append(stamped, Stamped{Line: line})
	}
	result := ParseCodexStream(stamped)
	if !result.Completed {
		t.Fatal("captured stream must complete")
	}
	if result.Reply != "pong" {
		t.Errorf("reply = %q", result.Reply)
	}
	if result.SessionID == nil || *result.SessionID != "00000000-0000-4000-8000-000000000001" {
		t.Errorf("session = %v", result.SessionID)
	}
	if result.Totals == nil {
		t.Fatal("missing totals")
	}
	eqI(t, "input", result.Totals.InputTokens, 11640)
	eqI(t, "cached", result.Totals.CachedTokens, 9600)
	eqI(t, "output", result.Totals.OutputTokens, 5)
	eqI(t, "reasoning", result.Totals.ReasoningTokens, 0)
	if result.ErrorOverride != nil || len(result.Calls) != 0 || len(result.Timeline) != 0 {
		t.Errorf("result = %+v", result)
	}
}

func TestCodexTerminalUsageIsNotAModelCall(t *testing.T) {
	result := ParseCodexStream(codexEvents(t, completion(map[string]any{
		"input_tokens": 200, "cached_input_tokens": 150,
		"output_tokens": 30, "reasoning_output_tokens": 10,
	})))
	if !result.Completed || result.Reply != "pong" {
		t.Fatalf("result = %+v", result)
	}
	if result.SessionID == nil || *result.SessionID != "codex-test-thread" {
		t.Errorf("session = %v", result.SessionID)
	}
	eqI(t, "input", result.Totals.InputTokens, 200)
	eqI(t, "cached", result.Totals.CachedTokens, 150)
	eqI(t, "output", result.Totals.OutputTokens, 30)
	eqI(t, "reasoning", result.Totals.ReasoningTokens, 10)
	if len(result.Calls) != 0 || len(result.Timeline) != 0 || result.UsageModel != nil {
		t.Errorf("no calls may be invented: %+v", result)
	}
}

func TestCodexMissingCountsAndExactZeroAreDistinct(t *testing.T) {
	result := ParseCodexStream(codexEvents(t, completion(map[string]any{
		"input_tokens": 0, "output_tokens": 7,
	})))
	eqI(t, "zero stays zero", result.Totals.InputTokens, 0)
	if result.Totals.CachedTokens != nil || result.Totals.ReasoningTokens != nil {
		t.Errorf("missing counts must stay nil: %+v", result.Totals)
	}
	for _, bad := range []any{nil, true, -1, "3", 1.5} {
		result := ParseCodexStream(codexEvents(t, completion(
			map[string]any{"input_tokens": bad})))
		if result.Totals.InputTokens != nil {
			t.Errorf("bad %v must give nil, got %v", bad, *result.Totals.InputTokens)
		}
	}
	result = ParseCodexStream([]Stamped{
		{ArrivalMS: f64(0), Line: "not json"},
		{ArrivalMS: f64(1), Line: "[]"},
		{ArrivalMS: f64(2), Line: "null"},
	})
	if result.Completed || result.Totals != nil {
		t.Errorf("garbage stream = %+v", result)
	}
}

func TestCodexTerminalOutcomeAndFinalReply(t *testing.T) {
	failed := map[string]any{"type": "turn.failed",
		"error": map[string]any{"message": "denied"}}
	result := ParseCodexStream(codexEvents(t, failed))
	if result.Completed || result.ErrorOverride == nil || *result.ErrorOverride != "denied" {
		t.Fatalf("failed = %+v", result)
	}
	if ParseCodexStream(codexEvents(t)).Completed {
		t.Error("no completion event must not complete")
	}
	restarted := ParseCodexStream(codexEvents(t, completion(map[string]any{}),
		map[string]any{"type": "turn.started"}))
	if restarted.Completed {
		t.Error("a new turn start clears the completion")
	}
	result = ParseCodexStream(codexEvents(t,
		map[string]any{"type": "error", "message": "retrying"},
		map[string]any{"type": "item.completed", "item": map[string]any{
			"type": "agent_message", "text": ""}},
		completion(map[string]any{})))
	if !result.Completed || result.Reply != "" || result.ErrorOverride != nil {
		t.Errorf("retried completion = %+v", result)
	}
	if ParseCodexStream(codexEvents(t, completion(map[string]any{}), failed)).Completed {
		t.Error("failure after completion must win")
	}
}
