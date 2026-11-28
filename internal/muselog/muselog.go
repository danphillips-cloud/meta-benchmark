// Package muselog ports lib/muse_log.py: shared Muse session
// log parsing. Records stay as generic decoded JSON
// (map[string]any) with recursive walking, so Muse log shape
// changes are absorbed the same way as in Python. Map keys are
// walked in sorted order for determinism, since Go maps do not
// keep JSON document order. List order is preserved exactly.
package muselog

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"time"
)

// Record is one decoded session log line.
type Record map[string]any

// Call is one harvested model call.
type Call struct {
	Model           *string  `json:"model"`
	DurationMS      *float64 `json:"duration_ms"`
	InputTokens     *int64   `json:"input_tokens"`
	OutputTokens    *int64   `json:"output_tokens"`
	CachedTokens    *int64   `json:"cached_tokens"`
	ReasoningTokens *int64   `json:"reasoning_tokens"`
	Retries         int      `json:"retries"`
	StalledMS       *int64   `json:"stalled_ms"`
}

// RetryInfo is per-call retry data in call order.
type RetryInfo struct {
	Retries   int    `json:"retries"`
	StalledMS *int64 `json:"stalled_ms"`
}

// TimelineRow is one per-step timeline entry.
type TimelineRow struct {
	At         string   `json:"at"`
	Operation  string   `json:"operation"`
	DurationMS *int64   `json:"duration_ms"`
	WireMS     *float64 `json:"wire_ms"`
}

// Metadata is model, provider and harness version from a log.
type Metadata struct {
	Model    *string `json:"model"`
	Provider *string `json:"provider"`
	Version  *string `json:"version"`
}

// Split is the model/tool/approval/Muse time split.
type Split struct {
	ModelMS    *float64 `json:"model_ms"`
	ToolMS     *float64 `json:"tool_ms"`
	ApprovalMS *float64 `json:"approval_ms"`
	MuseMS     *float64 `json:"muse_ms"`
}

// State is the live state of a session. Attempt is present only
// while retrying, matching the Python dict shape.
type State struct {
	State   string  `json:"state"`
	Tool    *string `json:"tool"`
	Attempt *string `json:"attempt,omitempty"`
}

// Interval is one closed tool or approval interval.
type Interval struct {
	Kind       string   `json:"kind"`
	Name       *string  `json:"name"`
	StartAt    string   `json:"start_at"`
	EndAt      string   `json:"end_at"`
	DurationMS float64  `json:"duration_ms"`
	WaitMS     *float64 `json:"wait_ms"`
}

// Intervals holds closed intervals plus unclosed names.
type Intervals struct {
	Intervals         []Interval `json:"intervals"`
	UnclosedTools     []*string  `json:"unclosed_tools"`
	UnclosedApprovals []*string  `json:"unclosed_approvals"`
}

// Turn is one finished interactive turn.
type Turn struct {
	Index                  int           `json:"index"`
	Status                 string        `json:"status"`
	Prompt                 string        `json:"prompt"`
	At                     string        `json:"at"`
	WallMS                 int64         `json:"wall_ms"`
	Calls                  []Call        `json:"calls"`
	Timeline               []TimelineRow `json:"timeline"`
	Split                  Split         `json:"split"`
	Model                  *string       `json:"model"`
	Version                *string       `json:"version"`
	CallsStartedBeforeTurn int           `json:"calls_started_before_turn"`
}

// Trace is one step of request lane bytes. Values pass through
// untouched, exactly as recorded.
type Trace struct {
	Step          any    `json:"step"`
	TotalBytes    any    `json:"total_bytes"`
	UserBytes     any    `json:"user_bytes"`
	OmittedGroups any    `json:"omitted_groups"`
	OmittedBytes  any    `json:"omitted_bytes"`
	Lanes         []Lane `json:"lanes"`
}

// Lane is one input lane aggregate.
type Lane struct {
	Lane      any `json:"lane"`
	Source    any `json:"source"`
	Wire      any `json:"wire"`
	Bytes     any `json:"bytes"`
	LaneCount any `json:"lane_count"`
}

// --- generic JSON helpers ---

func asMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
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

func intVal(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return i, true
		}
		f, err := n.Float64()
		if err == nil && f == math.Trunc(f) {
			return int64(f), true
		}
		return 0, false
	case float64:
		if n == math.Trunc(n) {
			return int64(n), true
		}
		return 0, false
	case int:
		return int64(n), true
	case int64:
		return n, true
	}
	return 0, false
}

func numPtr(v any) *float64 {
	if f, ok := numVal(v); ok {
		return &f
	}
	return nil
}

func intPtr(v any) *int64 {
	if i, ok := intVal(v); ok {
		return &i
	}
	return nil
}

func strPtr(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

// truthy mirrors Python truthiness for decoded JSON values.
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

// pyRound mirrors Python round() with no digits: half to even.
func pyRound(f float64) int64 {
	return int64(math.RoundToEven(f))
}

func usToISO(us int64) string {
	t := time.UnixMicro(us).UTC()
	if us%1_000_000 == 0 {
		return t.Format("2006-01-02T15:04:05+00:00")
	}
	return t.Format("2006-01-02T15:04:05.000000+00:00")
}

// --- session discovery and reading ---

// SessionsDir returns MUSE_SESSIONS_DIR or the default under the
// home directory. The default is correct inside WSL for Linux
// Muse installs.
func SessionsDir() string {
	if dir := os.Getenv("MUSE_SESSIONS_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "muse", "sessions")
}

func walkSessionLogs(fn func(path string, d fs.DirEntry) bool) {
	root := SessionsDir()
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() && d.Name() == "session.jsonl" {
			if !fn(path, d) {
				return filepath.SkipAll
			}
		}
		return nil
	})
}

// SessionLogPath finds **/<sessionID>/session.jsonl.
func SessionLogPath(sessionID string) (string, bool) {
	if sessionID == "" {
		return "", false
	}
	found := ""
	walkSessionLogs(func(path string, _ fs.DirEntry) bool {
		if filepath.Base(filepath.Dir(path)) == sessionID {
			found = path
			return false
		}
		return true
	})
	return found, found != ""
}

// NewestSessionPath returns the most recently modified log.
func NewestSessionPath() (string, bool) {
	best := ""
	var bestTime time.Time
	walkSessionLogs(func(path string, d fs.DirEntry) bool {
		info, err := d.Info()
		if err != nil {
			return true
		}
		if best == "" || info.ModTime().After(bestTime) {
			best, bestTime = path, info.ModTime()
		}
		return true
	})
	return best, best != ""
}

// ReadRecords returns all parseable object records of a session
// log, sorted by sequence. Python keeps any JSON value and would
// fail later on a non-object. Go records are objects by type, so
// non-object lines are skipped here.
func ReadRecords(path string) []Record {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []Record
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		dec := json.NewDecoder(bytes.NewReader(line))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			continue
		}
		if m, ok := asMap(v); ok {
			out = append(out, Record(m))
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return seqKey(out[i]) < seqKey(out[j])
	})
	return out
}

func seqKey(r Record) float64 {
	if f, ok := numVal(r["sequence"]); ok {
		return f
	}
	return 0
}

// --- recursive walking ---

// FindModelCompleted yields every model_completed node with a
// usage object, depth-first.
func FindModelCompleted(node any) []map[string]any {
	var out []map[string]any
	var walk func(v any)
	walk = func(v any) {
		switch n := v.(type) {
		case map[string]any:
			if n["kind"] == "model_completed" {
				if _, ok := asMap(n["usage"]); ok {
					out = append(out, n)
				}
			}
			for _, k := range sortedKeys(n) {
				walk(n[k])
			}
		case []any:
			for _, item := range n {
				walk(item)
			}
		}
	}
	walk(node)
	return out
}

// FindValue returns the first truthy value for key, depth-first.
func FindValue(node any, key string) (any, bool) {
	switch n := node.(type) {
	case map[string]any:
		if v, present := n[key]; present && truthy(v) {
			return v, true
		}
		for _, k := range sortedKeys(n) {
			if found, ok := FindValue(n[k], key); ok {
				return found, true
			}
		}
	case []any:
		for _, item := range n {
			if found, ok := FindValue(item, key); ok {
				return found, true
			}
		}
	}
	return nil, false
}

func eventKind(e Record) (string, bool) {
	payload, _ := asMap(e["payload"])
	event, _ := asMap(payload["event"])
	kind, ok := event["kind"].(string)
	return kind, ok && kind != ""
}

func recordedAt(e Record) (int64, bool) {
	return intVal(e["recorded_at"])
}

func payloadType(e Record) string {
	s, _ := e["payload_type"].(string)
	return s
}

// --- timeline ---

type rawRow struct {
	row TimelineRow
	ts  int64
}

func timelineRow(e Record, node map[string]any) (rawRow, bool) {
	ts, ok := recordedAt(e)
	ptype := payloadType(e)
	if !ok || ts == 0 || ptype == "" {
		return rawRow{}, false
	}
	label := ptype
	payload, _ := asMap(e["payload"])
	kind, hasKind := eventKind(e)
	if !hasKind {
		kind, hasKind = payload["kind"].(string)
	}
	if hasKind && kind != "" {
		label += " " + kind
	}
	var wire *float64
	if node != nil {
		wire = numPtr(node["duration_ms"])
	}
	return rawRow{row: TimelineRow{At: usToISO(ts), Operation: label, WireMS: wire}, ts: ts}, true
}

// TimelineRows builds the per-step timeline from records. The
// last row has no next record to end it, so its duration stays
// nil, never an invented 0.
func TimelineRows(records []Record) []TimelineRow {
	var raws []rawRow
	for _, e := range records {
		var node map[string]any
		if nodes := FindModelCompleted(map[string]any(e)); len(nodes) > 0 {
			node = nodes[0]
		}
		if row, ok := timelineRow(e, node); ok {
			raws = append(raws, row)
		}
	}
	rows := make([]TimelineRow, 0, len(raws))
	for i, raw := range raws {
		row := raw.row
		if i+1 < len(raws) {
			d := pyRound(float64(raws[i+1].ts-raw.ts) / 1000)
			row.DurationMS = &d
		}
		rows = append(rows, row)
	}
	return rows
}

// HarvestCalls reads a session log by id and returns its calls.
func HarvestCalls(sessionID string) []Call {
	path, ok := SessionLogPath(sessionID)
	if !ok {
		return nil
	}
	return CallsFromRecords(ReadRecords(path))
}

// BuildTimeline reads a session log by id and returns its
// timeline. The wall argument is accepted for parity with the
// Python signature and unused there too.
func BuildTimeline(sessionID string, _ float64) []TimelineRow {
	path, ok := SessionLogPath(sessionID)
	if !ok {
		return nil
	}
	return TimelineRows(ReadRecords(path))
}

// --- metadata ---

func takeStr(current *string, next any) *string {
	if current != nil && *current != "" {
		return current
	}
	if s, ok := next.(string); ok && s != "" {
		return &s
	}
	return current
}

// SessionMetadata pulls model, provider and harness version
// from the metadata record, falling back to the start-of-session
// intake record. Values only. Never workspace paths.
func SessionMetadata(records []Record) Metadata {
	var meta Metadata
	for _, e := range records {
		payload, _ := asMap(e["payload"])
		record, _ := asMap(payload["record"])
		switch payloadType(e) {
		case "runtime.session.metadata":
			meta.Model = takeStr(meta.Model, record["model_id"])
			meta.Provider = takeStr(meta.Provider, record["provider_id"])
			build, _ := asMap(record["build"])
			meta.Version = takeStr(meta.Version, build["semver"])
		case "runtime.command_intake.received":
			command, _ := asMap(record["command"])
			sessMeta, _ := asMap(command["session_metadata"])
			meta.Model = takeStr(meta.Model, sessMeta["model_id"])
			meta.Provider = takeStr(meta.Provider, sessMeta["provider_id"])
			build, _ := asMap(sessMeta["build"])
			meta.Version = takeStr(meta.Version, build["semver"])
		}
	}
	return meta
}

// --- calls and retries ---

var (
	openingRe  = regexp.MustCompile(`opening meta model stream attempt (\d+)/(\d+)`)
	retryingRe = regexp.MustCompile(`retrying meta model stream in (\d+)ms \(attempt (\d+)/(\d+)\)`)
)

func statusMessage(e Record) string {
	if kind, ok := eventKind(e); ok && kind == "status" {
		payload, _ := asMap(e["payload"])
		event, _ := asMap(payload["event"])
		msg, _ := event["message"].(string)
		return msg
	}
	return ""
}

type retryState struct {
	openings []float64 // recorded_at in ms
	delays   []int64
	retries  int
}

func stalledMS(info *retryState) *int64 {
	if len(info.openings) < 2 {
		return nil
	}
	var delays int64
	for _, d := range info.delays {
		delays += d
	}
	v := pyRound(info.openings[len(info.openings)-1] - info.openings[0] - float64(delays))
	return &v
}

// CallsFromRecords returns model calls in harvest shape. Retry
// status events accumulate until the record carrying the call's
// model_completed node. A record holding two nodes attaches the
// retry to the first node only. Calls with no status events get
// retries 0 and a nil stalled time.
func CallsFromRecords(records []Record) []Call {
	var calls []Call
	var pending *retryState
	for _, e := range records {
		if kind, ok := eventKind(e); ok && kind == "model_request_configured" {
			pending = &retryState{}
		}
		if msg := statusMessage(e); msg != "" {
			if pending == nil {
				pending = &retryState{}
			}
			if openingRe.MatchString(msg) {
				if ts, ok := recordedAt(e); ok {
					pending.openings = append(pending.openings, float64(ts)/1000)
				}
			}
			if m := retryingRe.FindStringSubmatch(msg); m != nil {
				pending.retries++
				delay, _ := strconv.ParseInt(m[1], 10, 64)
				pending.delays = append(pending.delays, delay)
			}
		}
		nodes := FindModelCompleted(map[string]any(e))
		if len(nodes) == 0 {
			continue
		}
		info := pending
		if info == nil {
			info = &retryState{}
		}
		stalled := stalledMS(info)
		for index, node := range nodes {
			usage, _ := asMap(node["usage"])
			call := Call{
				DurationMS:      numPtr(node["duration_ms"]),
				InputTokens:     intPtr(usage["input_tokens"]),
				OutputTokens:    intPtr(usage["output_tokens"]),
				CachedTokens:    intPtr(usage["cached_tokens"]),
				ReasoningTokens: intPtr(usage["reasoning_tokens"]),
			}
			if model, found := FindValue(map[string]any(e), "model_id"); found {
				call.Model = strPtr(model)
			}
			if index == 0 {
				call.Retries = info.retries
				call.StalledMS = stalled
			}
			calls = append(calls, call)
		}
		pending = nil
	}
	return calls
}

// RetryInfos returns per-call retry data in call order.
func RetryInfos(records []Record) []RetryInfo {
	calls := CallsFromRecords(records)
	infos := make([]RetryInfo, 0, len(calls))
	for _, c := range calls {
		infos = append(infos, RetryInfo{Retries: c.Retries, StalledMS: c.StalledMS})
	}
	return infos
}

// --- paired intervals and the time split ---

type interval struct {
	start, end int64
	name       *string
}

// pairedIntervals pairs started and terminal records by id.
// A started record with no terminal is reported unclosed,
// never estimated. Unclosed names keep start order.
func pairedIntervals(records []Record, startedType, terminalType, idKey string) ([]interval, []*string) {
	type openEntry struct {
		ts   int64
		name *string
	}
	open := map[string]openEntry{}
	var order []string
	var intervals []interval
	keyOf := func(v any) string {
		switch n := v.(type) {
		case nil:
			return "null:"
		case string:
			return "s:" + n
		case bool:
			if n {
				return "b:true"
			}
			return "b:false"
		case json.Number:
			return "n:" + n.String()
		default:
			if f, ok := numVal(v); ok {
				return "n:" + strconv.FormatFloat(f, 'g', -1, 64)
			}
			return "x:"
		}
	}
	for _, e := range records {
		ptype := payloadType(e)
		if ptype != startedType && ptype != terminalType {
			continue
		}
		payload, _ := asMap(e["payload"])
		record, _ := asMap(payload["record"])
		ts, ok := recordedAt(e)
		if !ok {
			continue
		}
		key := keyOf(record[idKey])
		if ptype == startedType {
			if _, seen := open[key]; !seen {
				order = append(order, key)
			}
			open[key] = openEntry{ts: ts, name: strPtr(record["tool_name"])}
		} else if entry, seen := open[key]; seen {
			delete(open, key)
			intervals = append(intervals, interval{start: entry.ts, end: ts, name: entry.name})
		}
	}
	var unclosed []*string
	for _, key := range order {
		if entry, seen := open[key]; seen {
			unclosed = append(unclosed, entry.name)
		}
	}
	return intervals, unclosed
}

// unionIntervals merges overlapping intervals. It returns
// ok=false when any interval ends before it starts.
func unionIntervals(intervals []interval) ([]interval, bool) {
	sorted := append([]interval(nil), intervals...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].start != sorted[j].start {
			return sorted[i].start < sorted[j].start
		}
		return sorted[i].end < sorted[j].end
	})
	var merged []interval
	for _, iv := range sorted {
		if iv.end < iv.start {
			return nil, false
		}
		if n := len(merged); n > 0 && iv.start <= merged[n-1].end {
			if iv.end > merged[n-1].end {
				merged[n-1].end = iv.end
			}
			merged[n-1].name = nil
		} else {
			merged = append(merged, interval{start: iv.start, end: iv.end})
		}
	}
	return merged, true
}

func overlapUS(a, b []interval) (int64, bool) {
	ua, okA := unionIntervals(a)
	ub, okB := unionIntervals(b)
	if !okA || !okB {
		return 0, false
	}
	var total int64
	for _, x := range ua {
		for _, y := range ub {
			lo := max(x.start, y.start)
			hi := min(x.end, y.end)
			if hi > lo {
				total += hi - lo
			}
		}
	}
	return total, true
}

func sumUS(intervals []interval) int64 {
	var total int64
	for _, iv := range intervals {
		total += iv.end - iv.start
	}
	return total
}

// TimeSplit computes the model/tool/approval/Muse split from
// event timestamps. No estimates: a started effect with no
// terminal makes its bucket nil, and Muse time with it. A
// bucket with no events at all is a recorded 0.
func TimeSplit(records []Record, wallMS, modelMS *float64) Split {
	toolRaw, toolOpen := pairedIntervals(records,
		"tool_batch.effect.started", "tool_batch.effect.terminal", "effect_id")
	apprRaw, apprOpen := pairedIntervals(records,
		"approval_wait.effect.started", "approval_wait.effect.terminal", "pending_action_id")
	toolIV, toolOK := unionIntervals(toolRaw)
	apprIV, apprOK := unionIntervals(apprRaw)

	var approvalMS *float64
	if len(apprOpen) == 0 && apprOK {
		v := float64(sumUS(apprIV)) / 1000
		approvalMS = &v
	}
	var toolMS *float64
	if len(toolOpen) == 0 && toolOK && apprOK {
		overlap, _ := overlapUS(toolIV, apprIV)
		v := float64(sumUS(toolIV)-overlap) / 1000
		toolMS = &v
	}
	var museMS *float64
	if wallMS != nil && modelMS != nil && toolMS != nil && approvalMS != nil {
		remainder := *wallMS - *modelMS - *toolMS - *approvalMS
		var modelIV []interval
		for _, record := range records {
			done, hasDone := recordedAt(record)
			for _, node := range FindModelCompleted(map[string]any(record)) {
				duration, hasDur := numVal(node["duration_ms"])
				if hasDone && hasDur {
					modelIV = append(modelIV, interval{
						start: done - pyRound(duration*1000), end: done})
				}
			}
		}
		occupied, occupiedOK := unionIntervals(modelIV)
		overlaps := !occupiedOK || sumUS(modelIV) != sumUS(occupied)
		if !overlaps {
			combined := append(append([]interval(nil), toolIV...), apprIV...)
			if overlap, _ := overlapUS(modelIV, combined); overlap != 0 {
				overlaps = true
			}
		}
		if remainder >= 0 && !overlaps {
			museMS = &remainder
		}
	}
	return Split{ModelMS: modelMS, ToolMS: toolMS, ApprovalMS: approvalMS, MuseMS: museMS}
}

// ToolIntervals returns named tool and approval intervals,
// exactly as recorded. Started effects with no terminal come
// back as names only, never with invented durations.
func ToolIntervals(records []Record) Intervals {
	if records == nil {
		records = []Record{}
	}
	toolRaw, toolOpen := pairedIntervals(records,
		"tool_batch.effect.started", "tool_batch.effect.terminal", "effect_id")
	apprRaw, apprOpen := pairedIntervals(records,
		"approval_wait.effect.started", "approval_wait.effect.terminal", "pending_action_id")
	var out []Interval
	for _, iv := range toolRaw {
		var wait *float64
		if waitUS, ok := overlapUS([]interval{iv}, apprRaw); ok {
			v := float64(waitUS) / 1000
			wait = &v
		}
		out = append(out, Interval{
			Kind: "tool", Name: iv.name,
			StartAt: usToISO(iv.start), EndAt: usToISO(iv.end),
			DurationMS: float64(iv.end-iv.start) / 1000, WaitMS: wait,
		})
	}
	zero := 0.0
	for _, iv := range apprRaw {
		out = append(out, Interval{
			Kind: "approval", Name: iv.name,
			StartAt: usToISO(iv.start), EndAt: usToISO(iv.end),
			DurationMS: float64(iv.end-iv.start) / 1000, WaitMS: &zero,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].StartAt < out[j].StartAt })
	if out == nil {
		out = []Interval{}
	}
	if toolOpen == nil {
		toolOpen = []*string{}
	}
	if apprOpen == nil {
		apprOpen = []*string{}
	}
	return Intervals{Intervals: out, UnclosedTools: toolOpen, UnclosedApprovals: apprOpen}
}

// --- live state ---

// LiveState returns the current state of a live session from
// its log records only: ended, waiting for approval, tool
// running, retrying connection, model call running, or idle.
func LiveState(records []Record) State {
	for _, e := range records {
		if payloadType(e) == "session.end" {
			return State{State: "ended"}
		}
	}
	if _, open := pairedIntervals(records,
		"approval_wait.effect.started", "approval_wait.effect.terminal",
		"pending_action_id"); len(open) > 0 {
		return State{State: "waiting for approval", Tool: open[len(open)-1]}
	}
	if _, open := pairedIntervals(records,
		"tool_batch.effect.started", "tool_batch.effect.terminal",
		"effect_id"); len(open) > 0 {
		return State{State: "tool running", Tool: open[len(open)-1]}
	}
	configured, completed := 0, 0
	var attempt string
	for _, e := range records {
		switch kind, _ := eventKind(e); kind {
		case "model_request_configured":
			configured++
			attempt = ""
		case "model_completed":
			completed++
			attempt = ""
		}
		if msg := statusMessage(e); msg != "" {
			opened := openingRe.FindStringSubmatch(msg)
			if retry := retryingRe.FindStringSubmatch(msg); retry != nil {
				attempt = retry[2] + "/" + retry[3]
			} else if opened != nil {
				if n, _ := strconv.Atoi(opened[1]); n >= 2 {
					attempt = opened[1] + "/" + opened[2]
				}
			}
		}
	}
	if configured > completed && attempt != "" {
		return State{State: "retrying connection", Attempt: &attempt}
	}
	if configured > completed {
		return State{State: "model call running"}
	}
	return State{State: "idle"}
}

// --- turns ---

func isActivity(e Record) bool {
	kind, _ := eventKind(e)
	if kind == "model_completed" || kind == "assistant_message_committed" {
		return true
	}
	ptype := payloadType(e)
	return ptype == "tool_batch.effect.terminal" ||
		ptype == "approval_wait.effect.terminal"
}

func promptOf(accepted Record) string {
	payload, _ := asMap(accepted["payload"])
	messages, _ := payload["model_messages"].([]any)
	for _, item := range messages {
		msg, _ := asMap(item)
		content, _ := msg["content"].([]any)
		for _, blockItem := range content {
			block, ok := asMap(blockItem)
			if !ok {
				continue
			}
			if text, ok := block["text"].(string); ok && text != "" {
				return text
			}
		}
	}
	return ""
}

// TurnOutcome maps only an explicit run outcome to a status.
// Anything else stays "unknown".
func TurnOutcome(records []Record) string {
	outcomes := map[string]string{
		"completed": "completed", "cancelled": "interrupted", "failed": "failed",
	}
	for i := len(records) - 1; i >= 0; i-- {
		record := records[i]
		if payloadType(record) != "runtime.session" {
			continue
		}
		if kind, _ := eventKind(record); kind != "terminal" {
			continue
		}
		payload, _ := asMap(record["payload"])
		event, _ := asMap(payload["event"])
		terminal, _ := event["terminal"].(string)
		if status, ok := outcomes[terminal]; ok {
			return status
		}
		return "unknown"
	}
	return "unknown"
}

// SplitTurns returns finished interactive turns, segmented on
// user_intent.accepted. The trailing turn is returned only when
// the session has ended. Turn wall ends at the segment's last
// activity record, so think time never counts. Turns with no
// model call are skipped.
func SplitTurns(records []Record) []Turn {
	meta := SessionMetadata(records)
	var starts []int
	ended := false
	for i, e := range records {
		if payloadType(e) == "runtime.user_intent.accepted" {
			starts = append(starts, i)
		}
		if payloadType(e) == "session.end" {
			ended = true
		}
	}
	var turns []Turn
	for n, start := range starts {
		isLast := n+1 == len(starts)
		if isLast && !ended {
			break
		}
		stop := len(records)
		if !isLast {
			stop = starts[n+1]
		}
		seg := records[start:stop]
		calls := CallsFromRecords(seg)
		if len(calls) == 0 {
			continue
		}
		var activity []int64
		for _, e := range seg {
			if isActivity(e) {
				if ts, ok := recordedAt(e); ok {
					activity = append(activity, ts)
				}
			}
		}
		startUS, hasStart := recordedAt(records[start])
		if !hasStart || len(activity) == 0 {
			continue
		}
		last := activity[0]
		for _, ts := range activity {
			if ts > last {
				last = ts
			}
		}
		wallMS := pyRound(float64(last-startUS) / 1000)
		early := 0
		for _, e := range seg {
			doneUS, hasDone := recordedAt(e)
			for _, node := range FindModelCompleted(map[string]any(e)) {
				dur, hasDur := numVal(node["duration_ms"])
				if hasDone && hasDur && float64(doneUS)-dur*1000 < float64(startUS) {
					early++
				}
			}
		}
		// Strict: one missing duration, or an early call, makes
		// the turn model total unknown.
		var modelMS *float64
		sum := 0.0
		all := true
		for _, c := range calls {
			if c.DurationMS == nil {
				all = false
				break
			}
			sum += *c.DurationMS
		}
		if all && early == 0 {
			modelMS = &sum
		}
		wallF := float64(wallMS)
		turns = append(turns, Turn{
			Index: n + 1, Status: TurnOutcome(seg),
			Prompt: promptOf(records[start]), At: usToISO(startUS),
			WallMS: wallMS, Calls: calls, Timeline: TimelineRows(seg),
			Split: TimeSplit(seg, &wallF, modelMS),
			Model: meta.Model, Version: meta.Version,
			CallsStartedBeforeTurn: early,
		})
	}
	return turns
}

// LiveCallsFromRecords returns calls and timeline for a growing
// log, with the same retry fields as the finished run.
func LiveCallsFromRecords(records []Record) ([]Call, []TimelineRow) {
	return CallsFromRecords(records), TimelineRows(records)
}

// --- input traces ---

func laneValue(node any) any {
	m, _ := asMap(node)
	return m["value"]
}

// InputTraces returns per-step request lane bytes. Byte counts
// only, exactly as recorded. No traces gives an empty slice.
func InputTraces(records []Record) []Trace {
	traces := []Trace{}
	for _, e := range records {
		if kind, _ := eventKind(e); kind != "model_input_trace_recorded" {
			continue
		}
		payload, _ := asMap(e["payload"])
		event, _ := asMap(payload["event"])
		bounded, _ := asMap(event["bounded"])
		aggregates, _ := bounded["aggregates"].([]any)
		lanes := make([]Lane, 0, len(aggregates))
		for _, item := range aggregates {
			a, _ := asMap(item)
			lanes = append(lanes, Lane{
				Lane: laneValue(a["logical_lane"]), Source: laneValue(a["source"]),
				Wire:  laneValue(a["provider_wire_destination"]),
				Bytes: a["byte_count"], LaneCount: a["lane_count"],
			})
		}
		traces = append(traces, Trace{
			Step: event["model_step"], TotalBytes: bounded["total_lane_bytes"],
			UserBytes:     bounded["current_user_message_bytes"],
			OmittedGroups: bounded["omitted_aggregate_group_count"],
			OmittedBytes:  bounded["omitted_aggregate_lane_bytes"],
			Lanes:         lanes,
		})
	}
	return traces
}
