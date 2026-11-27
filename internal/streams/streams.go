// Package streams ports lib/claude_stream.py and
// lib/codex_stream.py. One tracker is shared by the finished
// report parse and the live view, so a call, a running tool,
// and a live state mean the same thing everywhere.
package streams

import (
	"bytes"
	"encoding/json"
	"sort"
)

// Stamped is one stream line with its arrival time in ms. A nil
// arrival means the caller only has the lines, as the server
// does for a live run. Durations then stay nil.
type Stamped struct {
	ArrivalMS *float64
	Line      string
}

// Call is one Claude Code model call. Duration, output and
// reasoning stay nil: Claude Code reports no per-call duration,
// and per-call output counts are partial snapshots.
type Call struct {
	Model           *string  `json:"model"`
	DurationMS      *float64 `json:"duration_ms"`
	InputTokens     *int64   `json:"input_tokens"`
	OutputTokens    *int64   `json:"output_tokens"`
	CachedTokens    *int64   `json:"cached_tokens"`
	ReasoningTokens *int64   `json:"reasoning_tokens"`
}

// TimelineRow is one stream event on the timeline.
type TimelineRow struct {
	At         *string  `json:"at"`
	Operation  string   `json:"operation"`
	DurationMS *float64 `json:"duration_ms"`
	WireMS     *float64 `json:"wire_ms"`
}

// Totals holds the result event's aggregate token counts.
type Totals struct {
	InputTokens  *int64 `json:"input_tokens"`
	OutputTokens *int64 `json:"output_tokens"`
	CachedTokens *int64 `json:"cached_tokens"`
}

// State is a live state in muselog.LiveState names.
type State struct {
	State string  `json:"state"`
	Tool  *string `json:"tool"`
}

// Parsed is the report field set from a Claude stream.
type Parsed struct {
	SessionID      *string
	Reply          string
	Calls          []Call
	Timeline       []TimelineRow
	UsageModel     *string
	APIMS          *float64
	TTFTMS         *float64
	NumTurns       *int64
	CostUSD        *float64
	Totals         *Totals
	IsError        bool
	APIErrorStatus any
	LiveState      State
}

// Live is the live view of a run in progress.
type Live struct {
	Calls     []Call
	Timeline  []TimelineRow
	SessionID *string
	LiveState State
}

func asMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func numVal(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func intPtr(v any) *int64 {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return &i
		}
		if f, err := n.Float64(); err == nil && f == float64(int64(f)) {
			i := int64(f)
			return &i
		}
	case float64:
		i := int64(n)
		if float64(i) == n {
			return &i
		}
	case int:
		i := int64(n)
		return &i
	case int64:
		return &n
	}
	return nil
}

func numPtr(v any) *float64 {
	if f, ok := numVal(v); ok {
		return &f
	}
	return nil
}

func strPtr(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func truthy(v any) bool {
	switch n := v.(type) {
	case nil:
		return false
	case bool:
		return n
	case string:
		return n != ""
	case []any:
		return len(n) > 0
	case map[string]any:
		return len(n) > 0
	default:
		if f, ok := numVal(v); ok {
			return f != 0
		}
		return true
	}
}

// InputWithCache returns input tokens including cache, or nil.
// Strict: if any part was not recorded the total is unknown.
func InputWithCache(usage map[string]any) *int64 {
	var sum int64
	for _, key := range []string{
		"input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"} {
		v := intPtr(usage[key])
		if v == nil {
			return nil
		}
		sum += *v
	}
	return &sum
}

func contentBlocks(event map[string]any) []any {
	message, _ := asMap(event["message"])
	content, _ := message["content"].([]any)
	return content
}

// Tracker is the incremental state for FeedLiveEvent. Tool
// order keeps insertion order, like a Python dict.
type Tracker struct {
	ids        map[string]bool
	tools      map[string]*string
	toolOrder  []string
	calls      []Call
	usageModel *string
	ended      bool
	seenAny    bool
}

// NewLiveTracker returns fresh incremental state.
func NewLiveTracker() *Tracker {
	return &Tracker{ids: map[string]bool{}, tools: map[string]*string{}}
}

// Calls returns the calls recorded so far.
func (t *Tracker) Calls() []Call { return t.calls }

// UsageModel returns the last model seen on an assistant event.
func (t *Tracker) UsageModel() *string { return t.usageModel }

// FeedLiveEvent applies one parsed stream event. It returns
// the new call when a fresh message lands. Tool blocks are
// scanned on every assistant event, before the message id
// dedup, because Claude Code sends one event per content block
// under a shared id. Scanning after dedup would miss the
// common text then tool sequence entirely.
func (t *Tracker) FeedLiveEvent(event map[string]any) (Call, bool) {
	if event == nil {
		return Call{}, false
	}
	t.seenAny = true
	switch event["type"] {
	case "assistant":
		msg, _ := asMap(event["message"])
		// A "<synthetic>" message carries an error. It is not
		// a model call and holds no real tool work.
		if msg["model"] == "<synthetic>" {
			return Call{}, false
		}
		for _, item := range contentBlocks(event) {
			block, ok := asMap(item)
			if !ok || block["type"] != "tool_use" {
				continue
			}
			id, isStr := block["id"].(string)
			if !isStr || id == "" {
				continue
			}
			if _, seen := t.tools[id]; !seen {
				t.toolOrder = append(t.toolOrder, id)
			}
			t.tools[id] = strPtr(block["name"])
		}
		if mid, isStr := msg["id"].(string); isStr && mid != "" {
			if t.ids[mid] {
				return Call{}, false
			}
			t.ids[mid] = true
		}
		usage, _ := asMap(msg["usage"])
		if model, isStr := msg["model"].(string); isStr && model != "" {
			m := model
			t.usageModel = &m
		}
		// All-zero per-call usage means not reported. A real
		// call always has input.
		var inputTokens *int64
		if withCache := InputWithCache(usage); withCache != nil && *withCache != 0 {
			inputTokens = withCache
		}
		call := Call{Model: strPtr(msg["model"]), InputTokens: inputTokens}
		if inputTokens != nil {
			call.CachedTokens = intPtr(usage["cache_read_input_tokens"])
		}
		t.calls = append(t.calls, call)
		return call, true
	case "user":
		for _, item := range contentBlocks(event) {
			block, ok := asMap(item)
			if !ok || block["type"] != "tool_result" {
				continue
			}
			if id, isStr := block["tool_use_id"].(string); isStr {
				delete(t.tools, id)
			}
		}
	case "result":
		t.ended = true
	}
	return Call{}, false
}

// LiveState reports the tracker state in muselog names.
func (t *Tracker) LiveState() State {
	if t.ended {
		return State{State: "ended"}
	}
	for i := len(t.toolOrder) - 1; i >= 0; i-- {
		if name, open := t.tools[t.toolOrder[i]]; open {
			return State{State: "tool running", Tool: name}
		}
	}
	if t.seenAny {
		return State{State: "model call running"}
	}
	return State{State: "idle"}
}

type stampedEvent struct {
	arrival *float64
	event   map[string]any
}

func eventsFromLines(stamped []Stamped) []stampedEvent {
	var events []stampedEvent
	for _, s := range stamped {
		dec := json.NewDecoder(bytes.NewReader([]byte(s.Line)))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			continue
		}
		if m, ok := asMap(v); ok {
			events = append(events, stampedEvent{arrival: s.ArrivalMS, event: m})
		}
	}
	return events
}

func parseEvents(events []stampedEvent) Parsed {
	tracker := NewLiveTracker()
	var timeline []TimelineRow
	var result map[string]any
	var sessionID *string
	for i, se := range events {
		e := se.event
		if sessionID == nil || *sessionID == "" {
			sessionID = strPtr(e["session_id"])
			if sessionID != nil && *sessionID == "" {
				sessionID = nil
			}
		}
		etype, _ := e["type"].(string)
		label := etype
		if label == "" {
			label = "event"
		}
		if truthy(e["subtype"]) {
			if sub, isStr := e["subtype"].(string); isStr {
				label += " " + sub
			}
		}
		// The last event has nothing after it to end it, so
		// its duration is unknown: nil, never an invented 0.
		var duration *float64
		if i+1 < len(events) && events[i+1].arrival != nil && se.arrival != nil {
			d := *events[i+1].arrival - *se.arrival
			duration = &d
		}
		timeline = append(timeline, TimelineRow{
			At: strPtr(e["timestamp"]), Operation: label, DurationMS: duration})
		tracker.FeedLiveEvent(e)
		if etype == "result" {
			result = e
		}
	}
	parsed := Parsed{
		SessionID: sessionID, Calls: tracker.calls, Timeline: timeline,
		UsageModel: tracker.usageModel, LiveState: tracker.LiveState(),
	}
	if parsed.Calls == nil {
		parsed.Calls = []Call{}
	}
	if parsed.Timeline == nil {
		parsed.Timeline = []TimelineRow{}
	}
	if result != nil {
		usage, _ := asMap(result["usage"])
		if sid := strPtr(result["session_id"]); sid != nil && *sid != "" {
			parsed.SessionID = sid
		}
		if reply, isStr := result["result"].(string); isStr {
			parsed.Reply = reply
		}
		parsed.APIMS = numPtr(result["duration_api_ms"])
		parsed.TTFTMS = numPtr(result["ttft_ms"])
		parsed.NumTurns = intPtr(result["num_turns"])
		parsed.CostUSD = numPtr(result["total_cost_usd"])
		parsed.IsError = truthy(result["is_error"])
		parsed.APIErrorStatus = result["api_error_status"]
		parsed.Totals = &Totals{
			InputTokens:  InputWithCache(usage),
			OutputTokens: intPtr(usage["output_tokens"]),
			CachedTokens: intPtr(usage["cache_read_input_tokens"]),
		}
		if parsed.UsageModel == nil {
			if modelUsage, ok := asMap(result["modelUsage"]); ok && len(modelUsage) > 0 {
				keys := make([]string, 0, len(modelUsage))
				for k := range modelUsage {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				first := keys[0]
				parsed.UsageModel = &first
			}
		}
	}
	return parsed
}

// ParseClaudeStream maps stamped Claude Code stream-json lines
// onto report fields. One call per unique assistant message id.
func ParseClaudeStream(stamped []Stamped) Parsed {
	return parseEvents(eventsFromLines(stamped))
}

// LiveFromLines returns live calls, timeline and state for a
// run in progress, from raw lines as they land in events.jsonl.
func LiveFromLines(lines []string) Live {
	stamped := make([]Stamped, 0, len(lines))
	for _, line := range lines {
		stamped = append(stamped, Stamped{Line: line})
	}
	parsed := parseEvents(eventsFromLines(stamped))
	return Live{Calls: parsed.Calls, Timeline: parsed.Timeline,
		SessionID: parsed.SessionID, LiveState: parsed.LiveState}
}
