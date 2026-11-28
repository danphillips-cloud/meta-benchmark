// Package report defines the run report contract shared by
// the runner (writer) and any reader that needs typed access.
package report

import "encoding/json"

// Report mirrors report.json (and its summary line in index.jsonl).
// The field set comes from BASE_REPORT in run-muse plus the fields
// written only by some routes (turn imports, Codex). Pointer fields
// mark every value Python can hold as None: a missing measurement
// decodes to nil and marshals back to null, never to a zero. Only
// fields that are never null in BASE_REPORT or in surveyed runs
// (prompt, reply, calls, timeline, metrics_unavailable, raced)
// are plain values.
type Report struct {
	At              *string `json:"at"`
	FinishedAt      *string `json:"finished_at"`
	RunID           *string `json:"run_id"`
	Prompt          string  `json:"prompt"`
	Model           *string `json:"model"`
	Provider        *string `json:"provider"`
	SessionID       *string `json:"session_id"`
	ContextMode     *string `json:"context_mode"`
	ComparisonID    *string `json:"comparison_id"`
	Round           *int    `json:"round"`
	CompareMode     *string `json:"compare_mode"`
	Raced           bool    `json:"raced"`
	SuiteID         *string `json:"suite_id"`
	SuitePrompt     *string `json:"suite_prompt"`
	BillingMode     *string `json:"billing_mode"`
	RequestedModel  *string `json:"requested_model"`
	ReasoningEffort *string `json:"reasoning_effort,omitempty"`
	HarnessVersion  *string `json:"harness_version"`

	ToolMS     *float64 `json:"tool_ms"`
	ApprovalMS *float64 `json:"approval_ms"`
	MuseMS     *float64 `json:"muse_ms"`

	NeedsApprovalTool *string  `json:"needs_approval_tool"`
	Status            *string  `json:"status"`
	OutcomeRecorded   *bool    `json:"outcome_recorded,omitempty"`
	TimeoutSeconds    *int     `json:"timeout_seconds"`
	Command           *string  `json:"command"`
	WallMS            *float64 `json:"wall_ms"`
	ExitCode          *int     `json:"exit_code"`
	Reply             string   `json:"reply"`
	Error             *string  `json:"error"`

	Calls    []Call        `json:"calls"`
	Timeline []TimelineRow `json:"timeline"`

	APIMS      *float64 `json:"api_ms"`
	TTFTMS     *float64 `json:"ttft_ms"`
	NumTurns   *int     `json:"num_turns"`
	CostUSD    *float64 `json:"cost_usd"`
	CostSource *string  `json:"cost_source"`
	Pricing    *Pricing `json:"pricing"`

	AllowanceStart *Allowance      `json:"allowance_start"`
	AllowanceEnd   *Allowance      `json:"allowance_end"`
	AllowanceDelta *AllowanceDelta `json:"allowance_delta"`

	Totals             *Totals         `json:"totals"`
	TaskValidation     *TaskValidation `json:"task_validation"`
	MetricsUnavailable bool            `json:"metrics_unavailable"`
	TurnIndex          *int            `json:"turn_index"`
	// Count of calls that started before this turn. Turn imports
	// only. Absent elsewhere, never stored as a bool.
	CallsStartedBeforeTurn *int `json:"calls_started_before_turn,omitempty"`
}

// Call is one model call. Every measurement can be missing.
// CacheCreationPresent records whether the key existed at all:
// the legacy Anthropic rule in lib/server.py treats an absent key
// differently from a present null, and a plain pointer cannot.
type Call struct {
	Model               *string  `json:"model"`
	DurationMS          *float64 `json:"duration_ms"`
	InputTokens         *int64   `json:"input_tokens"`
	OutputTokens        *int64   `json:"output_tokens"`
	CachedTokens        *int64   `json:"cached_tokens"`
	ReasoningTokens     *int64   `json:"reasoning_tokens"`
	CacheCreationTokens *int64   `json:"cache_creation_tokens,omitempty"`
	FreshInputTokens    *int64   `json:"fresh_input_tokens,omitempty"`
	Retries             *int     `json:"retries"`
	StalledMS           *float64 `json:"stalled_ms"`
	StopReason          *string  `json:"stop_reason,omitempty"`

	CacheCreationPresent bool `json:"-"`
}

func (c *Call) UnmarshalJSON(data []byte) error {
	type plain Call
	if err := json.Unmarshal(data, (*plain)(c)); err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	_, c.CacheCreationPresent = raw["cache_creation_tokens"]
	return nil
}

// TimelineRow is one recorded step in a run.
type TimelineRow struct {
	At         *string  `json:"at"`
	Operation  string   `json:"operation"`
	DurationMS *float64 `json:"duration_ms"`
	WireMS     *float64 `json:"wire_ms"`
}

// Totals holds run-level token sums when the harness reported
// them. Presence of cache_creation_tokens is tested in run-muse,
// so it is tracked like in Call.
type Totals struct {
	InputTokens         *int64 `json:"input_tokens"`
	OutputTokens        *int64 `json:"output_tokens"`
	CachedTokens        *int64 `json:"cached_tokens"`
	ReasoningTokens     *int64 `json:"reasoning_tokens,omitempty"`
	CacheCreationTokens *int64 `json:"cache_creation_tokens,omitempty"`

	CacheCreationPresent bool `json:"-"`
}

func (t *Totals) UnmarshalJSON(data []byte) error {
	type plain Totals
	if err := json.Unmarshal(data, (*plain)(t)); err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	_, t.CacheCreationPresent = raw["cache_creation_tokens"]
	return nil
}

// Pricing holds the per-million-token rates a cost was computed from.
type Pricing struct {
	InputPerMTok         float64  `json:"input_per_mtok"`
	CachedPerMTok        float64  `json:"cached_per_mtok"`
	OutputPerMTok        float64  `json:"output_per_mtok"`
	CacheCreationPerMTok *float64 `json:"cache_creation_per_mtok,omitempty"`
	Model                string   `json:"model"`
	Source               string   `json:"source"`
	Fetched              string   `json:"fetched"`
}

// Allowance is one subscription allowance reading.
type Allowance struct {
	Window *AllowanceWindow `json:"window"`
	Weekly *AllowanceWindow `json:"weekly"`
}

type AllowanceWindow struct {
	UsedPercent *float64 `json:"used_percent"`
	ResetsAtMS  *int64   `json:"resets_at_ms"`
}

// AllowanceDelta is percent movement per bucket. A bucket is null
// when it cannot be known (lib/pricing.py allowance_delta).
type AllowanceDelta struct {
	Window *float64 `json:"window"`
	Weekly *float64 `json:"weekly"`
}

// TaskValidation records the checks run against one reply.
type TaskValidation struct {
	Status string      `json:"status"`
	Checks []TaskCheck `json:"checks"`
	Reason *string     `json:"reason,omitempty"`
}

type TaskCheck struct {
	Check  string `json:"check"`
	Value  string `json:"value"`
	Passed bool   `json:"passed"`
}
