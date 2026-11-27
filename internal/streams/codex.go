package streams

import (
	"bytes"
	"encoding/json"
)

// CodexTotals holds aggregate turn usage. It is turn usage, not
// per-call telemetry.
type CodexTotals struct {
	InputTokens     *int64 `json:"input_tokens"`
	CachedTokens    *int64 `json:"cached_tokens"`
	OutputTokens    *int64 `json:"output_tokens"`
	ReasoningTokens *int64 `json:"reasoning_tokens"`
}

// CodexResult is the parsed Codex exec stream. Calls and
// Timeline are always empty: arrival times, items and tool
// events must never be counted as model calls or model time.
type CodexResult struct {
	SessionID     *string
	Reply         string
	Calls         []Call
	Timeline      []TimelineRow
	UsageModel    *string
	Totals        *CodexTotals
	Completed     bool
	ErrorOverride *string
}

// count accepts only a non-negative JSON integer, matching
// Python's type(value) is int check. A float spelling, a bool,
// a string, and a missing value all stay nil.
func count(v any) *int64 {
	n, isNumber := v.(json.Number)
	if !isNumber {
		if i, isInt := v.(int64); isInt && i >= 0 {
			return &i
		}
		if i, isInt := v.(int); isInt && i >= 0 {
			v64 := int64(i)
			return &v64
		}
		return nil
	}
	i, err := n.Int64()
	if err != nil || i < 0 {
		return nil
	}
	return &i
}

// ParseCodexStream parses stamped Codex exec JSONL lines
// without inventing telemetry. The last completed agent
// message is the final answer, not a concatenation.
func ParseCodexStream(stamped []Stamped) CodexResult {
	result := CodexResult{Calls: []Call{}, Timeline: []TimelineRow{}}
	for _, s := range stamped {
		dec := json.NewDecoder(bytes.NewReader([]byte(s.Line)))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			continue
		}
		event, ok := asMap(v)
		if !ok {
			continue
		}
		switch event["type"] {
		case "thread.started":
			result.SessionID = strPtr(event["thread_id"])
		case "turn.started":
			result.Completed = false
			result.Totals = nil
		case "item.completed":
			item, _ := asMap(event["item"])
			if item["type"] == "agent_message" {
				if text, isStr := item["text"].(string); isStr {
					result.Reply = text
				}
			}
		case "turn.completed":
			result.Completed = true
			usage, _ := asMap(event["usage"])
			result.Totals = &CodexTotals{
				InputTokens:     count(usage["input_tokens"]),
				CachedTokens:    count(usage["cached_input_tokens"]),
				OutputTokens:    count(usage["output_tokens"]),
				ReasoningTokens: count(usage["reasoning_output_tokens"]),
			}
		case "turn.failed":
			errorObj, _ := asMap(event["error"])
			message := strPtr(errorObj["message"])
			if message == nil || *message == "" {
				fallback := "Codex turn failed"
				message = &fallback
			}
			result.ErrorOverride = message
			result.Completed = false
		case "error":
			// Transport errors may be retried. A later
			// turn.completed is the authoritative outcome.
			if message, isStr := event["message"].(string); isStr {
				result.ErrorOverride = &message
			}
		}
	}
	if result.Completed {
		result.ErrorOverride = nil
	}
	return result
}
