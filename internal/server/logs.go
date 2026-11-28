package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"meta-benchmark/internal/muselog"
	"meta-benchmark/internal/streams"
)

// runMap is one index entry as generic decoded JSON. Numbers
// keep their json.Number spelling until a computation needs
// them, so stored values pass through byte-faithfully.
type runMap = map[string]any

func getStr(m runMap, key string) string {
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}

func num(v any) (float64, bool) {
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

func getNum(m runMap, key string) (float64, bool) { return num(m[key]) }

func getCalls(m runMap) []runMap {
	raw, ok := m["calls"].([]any)
	if !ok {
		return nil
	}
	calls := make([]runMap, 0, len(raw))
	for _, c := range raw {
		if cm, ok := c.(map[string]any); ok {
			calls = append(calls, cm)
		}
	}
	return calls
}

func clone(m runMap) runMap {
	out := make(runMap, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func validRunID(id string) bool {
	return id != "" && !strings.ContainsAny(id, "/\\") && id != "." && id != ".."
}

func joinRunFile(dataDir, runID, name string) string {
	if !validRunID(runID) {
		return ""
	}
	return filepath.Join(dataDir, runID, name)
}

func parseAt(v any) (time.Time, bool) {
	s, ok := v.(string)
	if !ok || s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05"} {
		if t, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func isStaleRunning(run runMap) bool {
	started, ok := parseAt(run["at"])
	if !ok {
		return false
	}
	timeout, ok := getNum(run, "timeout_seconds")
	if !ok || timeout == 0 {
		timeout = 1800
	}
	return time.Since(started).Seconds() > timeout+300
}

// --- call conversion ---

func f64OrNil(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func i64OrNil(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func strOrNil(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func museCallToMap(c muselog.Call) runMap {
	return runMap{
		"model": strOrNil(c.Model), "duration_ms": f64OrNil(c.DurationMS),
		"input_tokens": i64OrNil(c.InputTokens), "output_tokens": i64OrNil(c.OutputTokens),
		"cached_tokens": i64OrNil(c.CachedTokens), "reasoning_tokens": i64OrNil(c.ReasoningTokens),
		"retries": c.Retries, "stalled_ms": i64OrNil(c.StalledMS),
	}
}

func streamCallToMap(c streams.Call) runMap {
	return runMap{
		"model": strOrNil(c.Model), "duration_ms": f64OrNil(c.DurationMS),
		"input_tokens": i64OrNil(c.InputTokens), "output_tokens": i64OrNil(c.OutputTokens),
		"cached_tokens": i64OrNil(c.CachedTokens), "reasoning_tokens": i64OrNil(c.ReasoningTokens),
	}
}

func callsToAny(calls []runMap) []any {
	out := make([]any, 0, len(calls))
	for _, c := range calls {
		out = append(out, c)
	}
	return out
}

func museTimelineToMaps(rows []muselog.TimelineRow) []runMap {
	out := make([]runMap, 0, len(rows))
	for _, r := range rows {
		out = append(out, runMap{
			"at": r.At, "operation": r.Operation,
			"duration_ms": i64OrNil(r.DurationMS), "wire_ms": f64OrNil(r.WireMS),
		})
	}
	return out
}

func streamTimelineToMaps(rows []streams.TimelineRow) []runMap {
	out := make([]runMap, 0, len(rows))
	for _, r := range rows {
		out = append(out, runMap{
			"at": strOrNil(r.At), "operation": r.Operation,
			"duration_ms": f64OrNil(r.DurationMS), "wire_ms": f64OrNil(r.WireMS),
		})
	}
	return out
}

// --- index loading ---

func (s *Server) loadRuns() []runMap {
	data, err := os.ReadFile(s.indexPath())
	if err != nil {
		return nil
	}
	var runs []runMap
	for _, line := range splitLines(data) {
		if strings.TrimSpace(line) == "" {
			// Python json.loads on a blank line raises and the
			// line is skipped. Same outcome, cheaper check.
			continue
		}
		dec := json.NewDecoder(bytes.NewReader([]byte(line)))
		dec.UseNumber()
		var m map[string]any
		if err := dec.Decode(&m); err != nil {
			continue
		}
		runs = append(runs, m)
	}
	// Keep the last entry per run_id, in first-seen order.
	order := []string{}
	byKey := map[string]runMap{}
	for i, r := range runs {
		key := getStr(r, "run_id")
		if key == "" {
			key = fmt.Sprintf("no-run-id-%d", i)
		}
		if _, seen := byKey[key]; !seen {
			order = append(order, key)
		}
		byKey[key] = r
	}
	fixed := make([]runMap, 0, len(order))
	for _, key := range order {
		r := byKey[key]
		report := joinRunFile(s.dataDir, getStr(r, "run_id"), "report.json")
		_, reportErr := os.Stat(report)
		if getStr(r, "status") == "running" && reportErr != nil && isStaleRunning(r) {
			r = clone(r)
			r["status"] = "interrupted"
		}
		if p := getStr(r, "provider"); p == "muse-retro" || p == "muse-watch" {
			if recorded, isBool := r["outcome_recorded"].(bool); !isBool || !recorded {
				r = clone(r)
				r["status"] = "unknown"
			}
		}
		fixed = append(fixed, r)
	}
	// Grouped rows should agree with live stats for running runs.
	enriched := make([]runMap, 0, len(fixed))
	for _, r := range fixed {
		if getStr(r, "status") == "running" && getStr(r, "session_id") != "" &&
			getStr(r, "provider") != "codex" {
			if live, _ := s.liveCalls(getStr(r, "session_id")); len(live) > 0 {
				r = clone(r)
				maps := make([]runMap, 0, len(live))
				for _, c := range live {
					maps = append(maps, museCallToMap(c))
				}
				r["calls"] = callsToAny(maps)
			}
		} else if getStr(r, "status") == "running" && getStr(r, "provider") == "claude-code" {
			if live, has := s.claudeLive(r); has && len(live.Calls) > 0 {
				r = clone(r)
				maps := make([]runMap, 0, len(live.Calls))
				for _, c := range live.Calls {
					maps = append(maps, streamCallToMap(c))
				}
				r["calls"] = callsToAny(maps)
			}
		}
		enriched = append(enriched, r)
	}
	return enriched
}

// --- derived fields ---

const modelOverlapNote = "A model call started before this turn, so model time can't be set against wall"

func modelOverlaps(r runMap) bool {
	if b, ok := r["calls_started_before_turn"].(bool); ok && b {
		return true
	}
	if n, ok := num(r["calls_started_before_turn"]); ok && n != 0 {
		return true
	}
	if p := getStr(r, "provider"); p != "muse-retro" && p != "muse-watch" {
		return false
	}
	wall, ok := getNum(r, "wall_ms")
	if !ok || wall == 0 {
		return false
	}
	calls := getCalls(r)
	if len(calls) == 0 {
		return false
	}
	var sum float64
	for _, c := range calls {
		d, ok := getNum(c, "duration_ms")
		if !ok {
			return false
		}
		sum += d
	}
	return sum > wall
}

func runModelMS(r runMap) (any, bool) {
	if modelOverlaps(r) {
		return nil, false
	}
	calls := getCalls(r)
	if len(calls) > 0 {
		var sum float64
		all := true
		for _, c := range calls {
			d, ok := getNum(c, "duration_ms")
			if !ok {
				all = false
				break
			}
			sum += d
		}
		if all {
			return sum, true
		}
	}
	if v := r["api_ms"]; v != nil {
		return v, true
	}
	return nil, false
}

func callInputTokens(r, call runMap) any {
	_, hasCache := call["cache_creation_tokens"]
	if getStr(r, "provider") == "anthropic" && !hasCache {
		return nil
	}
	return call["input_tokens"]
}

func runTokens(r runMap, key string) any {
	if totals, ok := r["totals"].(map[string]any); ok && totals != nil {
		return totals[key]
	}
	calls := getCalls(r)
	if len(calls) == 0 {
		return nil
	}
	var sum float64
	for _, c := range calls {
		var v any
		if key == "input_tokens" {
			v = callInputTokens(r, c)
		} else {
			v = c[key]
		}
		f, ok := num(v)
		if !ok {
			return nil
		}
		sum += f
	}
	return sum
}

func harnessVersion(r runMap) any {
	if getStr(r, "provider") == "echo" {
		return nil
	}
	return r["harness_version"]
}

func sessionRow(r runMap) map[string]any {
	modelMS, hasModel := runModelMS(r)
	calls := getCalls(r)
	var callsVal any
	if getStr(r, "provider") == "codex" {
		callsVal = nil
	} else {
		callsVal = len(calls)
	}
	var overhead any
	if hasModel {
		if wall, ok := getNum(r, "wall_ms"); ok {
			if mv, ok := num(modelMS); ok {
				diff := wall - mv
				if diff < 0 {
					diff = 0
				}
				overhead = diff
			}
		}
	}
	var note any
	if modelOverlaps(r) {
		note = modelOverlapNote
	}
	var lastCall runMap
	if len(calls) > 0 {
		lastCall = calls[len(calls)-1]
	} else {
		lastCall = runMap{}
	}
	raced, _ := r["raced"].(bool)
	return map[string]any{
		"run_id": r["run_id"], "at": r["at"], "prompt": r["prompt"],
		"model": r["model"], "wall_ms": r["wall_ms"], "calls": callsVal,
		"provider": r["provider"], "context_mode": r["context_mode"],
		"comparison_id": r["comparison_id"], "round": r["round"],
		"compare_mode": r["compare_mode"], "raced": raced,
		"suite_id": r["suite_id"], "suite_prompt": r["suite_prompt"],
		"harness_version": harnessVersion(r), "cost_usd": r["cost_usd"],
		"cost_source": r["cost_source"], "pricing": r["pricing"],
		"allowance_start": r["allowance_start"], "allowance_end": r["allowance_end"],
		"allowance_delta": r["allowance_delta"], "ttft_ms": r["ttft_ms"],
		"task_validation": r["task_validation"], "status": r["status"],
		"model_ms": modelMS, "model_note": note, "overhead_ms": overhead,
		"input_tokens":  runTokens(r, "input_tokens"),
		"output_tokens": runTokens(r, "output_tokens"),
		"tool_ms":       r["tool_ms"], "approval_ms": r["approval_ms"],
		"muse_ms":            r["muse_ms"],
		"last_input_tokens":  callInputTokens(r, lastCall),
		"last_output_tokens": lastCall["output_tokens"],
	}
}

// runSplit returns the stored time split, or one computed from
// the session log. Missing buckets stay nil, never estimated.
// hasRecords distinguishes a found but empty log from no log.
func (s *Server) runSplit(run runMap, records []muselog.Record, hasRecords bool) map[string]any {
	modelMS, _ := runModelMS(run)
	empty := func() map[string]any {
		return map[string]any{"model_ms": modelMS, "tool_ms": nil,
			"approval_ms": nil, "muse_ms": nil}
	}
	if run["tool_ms"] != nil || run["approval_ms"] != nil || run["muse_ms"] != nil {
		return map[string]any{"model_ms": modelMS, "tool_ms": run["tool_ms"],
			"approval_ms": run["approval_ms"], "muse_ms": run["muse_ms"]}
	}
	if getStr(run, "provider") == "codex" || getStr(run, "session_id") == "" {
		return empty()
	}
	if !hasRecords {
		path, ok := s.liveSessionLog(getStr(run, "session_id"))
		if !ok {
			return empty()
		}
		records, hasRecords = s.logRecords(path)
		if !hasRecords {
			return empty()
		}
	}
	wallPtr := numPtrAny(run["wall_ms"])
	modelPtr := numPtrAny(modelMS)
	split := muselog.TimeSplit(records, wallPtr, modelPtr)
	return map[string]any{
		"model_ms": f64OrNil(split.ModelMS), "tool_ms": f64OrNil(split.ToolMS),
		"approval_ms": f64OrNil(split.ApprovalMS), "muse_ms": f64OrNil(split.MuseMS),
	}
}

func numPtrAny(v any) *float64 {
	if f, ok := num(v); ok {
		return &f
	}
	return nil
}

// --- /api/logs ---

func pickSelected(runs []runMap, runID string) runMap {
	if runID != "" {
		for _, r := range runs {
			if getStr(r, "run_id") == runID {
				return r
			}
		}
	}
	for i := len(runs) - 1; i >= 0; i-- {
		if getStr(runs[i], "status") == "running" {
			return runs[i]
		}
	}
	for i := len(runs) - 1; i >= 0; i-- {
		if getStr(runs[i], "status") == "completed" {
			return runs[i]
		}
	}
	if len(runs) > 0 {
		return runs[len(runs)-1]
	}
	return runMap{}
}

func withCalls(run runMap, calls []runMap) runMap {
	out := clone(run)
	out["calls"] = callsToAny(calls)
	return out
}

// ReadLogs builds the /api/logs payload, mirroring
// lib/server.py read_logs including live enrichment.
func (s *Server) ReadLogs(runID string) map[string]any {
	runs := s.loadRuns()
	sessions := make([]any, 0, len(runs))
	for i := len(runs) - 1; i >= 0; i-- {
		sessions = append(sessions, sessionRow(runs[i]))
	}
	selected := pickSelected(runs, runID)

	var liveTimeline []runMap
	var claudeState *streams.State
	var claudeTimeline []runMap
	if getStr(selected, "status") == "running" && getStr(selected, "session_id") != "" &&
		getStr(selected, "provider") != "codex" {
		live, timeline := s.liveCalls(getStr(selected, "session_id"))
		liveTimeline = museTimelineToMaps(timeline)
		if len(live) > 0 {
			maps := make([]runMap, 0, len(live))
			for _, c := range live {
				maps = append(maps, museCallToMap(c))
			}
			selected = withCalls(selected, maps)
		}
	}
	if getStr(selected, "status") == "running" && getStr(selected, "provider") == "claude-code" {
		if live, has := s.claudeLive(selected); has {
			claudeTimeline = streamTimelineToMaps(live.Timeline)
			state := live.LiveState
			claudeState = &state
			if len(live.Calls) > 0 {
				maps := make([]runMap, 0, len(live.Calls))
				for _, c := range live.Calls {
					maps = append(maps, streamCallToMap(c))
				}
				selected = withCalls(selected, maps)
			}
			if len(liveTimeline) == 0 {
				liveTimeline = claudeTimeline
			}
		}
	}

	var elapsed any
	if getStr(selected, "status") == "running" {
		if started, ok := parseAt(selected["at"]); ok {
			elapsed = int64(math.RoundToEven(
				float64(time.Since(started)) / float64(time.Millisecond)))
		}
	}

	var selectedRecords []muselog.Record
	hasRecords := false
	if getStr(selected, "session_id") != "" && getStr(selected, "provider") != "codex" {
		if path, ok := s.liveSessionLog(getStr(selected, "session_id")); ok {
			selectedRecords, hasRecords = s.logRecords(path)
			if !hasRecords {
				// The log vanished between resolve and read.
				// Python would hold an empty record list here.
				selectedRecords, hasRecords = []muselog.Record{}, true
			}
		}
	}

	calls := getCalls(selected)
	events := []any{}
	for _, call := range calls {
		model := call["model"]
		if model == nil {
			model = selected["model"]
		}
		retries := call["retries"]
		if retries == nil {
			retries = 0
		}
		exitF, exitOK := getNum(selected, "exit_code")
		events = append(events, map[string]any{
			"prompt": selected["prompt"], "reply": selected["reply"],
			"model": model, "wire_ms": call["duration_ms"],
			"gen_ai.usage.input_tokens":     callInputTokens(selected, call),
			"gen_ai.usage.output_tokens":    call["output_tokens"],
			"gen_ai.usage.cached_tokens":    call["cached_tokens"],
			"gen_ai.usage.reasoning_tokens": call["reasoning_tokens"],
			"retries":                       retries, "stalled_ms": call["stalled_ms"],
			"operation": "model call", "ok": exitOK && exitF == 0,
		})
	}
	if hasRecords {
		for index, info := range muselog.RetryInfos(selectedRecords) {
			if index < len(events) {
				event := events[index].(map[string]any)
				event["retries"] = info.Retries
				event["stalled_ms"] = i64OrNil(info.StalledMS)
			}
		}
	}
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}

	errs := []any{}
	exitV := selected["exit_code"]
	exitF, exitIsNum := num(exitV)
	if selected["error"] != nil || (exitV != nil && !(exitIsNum && exitF == 0)) {
		errType := selected["error"]
		if errType == nil {
			errType = fmt.Sprintf("exit %v", exitV)
		}
		errs = append(errs, map[string]any{"at": selected["at"],
			"operation": selected["run_id"], "error_type": errType})
	}
	if metricsDown, _ := selected["metrics_unavailable"].(bool); metricsDown &&
		getStr(selected, "provider") != "echo" {
		errs = append(errs, map[string]any{"at": selected["at"],
			"operation":  selected["run_id"],
			"error_type": "model metrics unavailable for this run"})
	}
	if len(errs) > 3 {
		errs = errs[len(errs)-3:]
	}

	// The full timeline lives in the selected run's report.json.
	// A missing or empty stored timeline falls back to live.
	timeline := []any{}
	var stored []runMap
	if reportFile := joinRunFile(s.dataDir, getStr(selected, "run_id"), "report.json"); reportFile != "" {
		if data, err := os.ReadFile(reportFile); err == nil {
			dec := json.NewDecoder(bytes.NewReader(data))
			dec.UseNumber()
			var full map[string]any
			if err := dec.Decode(&full); err == nil {
				if tl, ok := full["timeline"].([]any); ok {
					for _, item := range tl {
						if tm, ok := item.(map[string]any); ok {
							stored = append(stored, tm)
						}
					}
				}
			}
		}
	}
	source := stored
	if len(source) == 0 {
		source = liveTimeline
	}
	for _, tm := range source {
		at := tm["at"]
		if at == nil {
			at = selected["at"]
		}
		timeline = append(timeline, map[string]any{
			"at": at, "operation": tm["operation"],
			"duration_ms": tm["duration_ms"], "wire_ms": tm["wire_ms"],
			"ok": true, "error_type": nil,
		})
	}

	var file any
	if len(runs) > 0 {
		callsLabel := strconv.Itoa(len(calls))
		if getStr(selected, "provider") == "codex" {
			callsLabel = "–"
		}
		file = fmt.Sprintf("%d run(s), showing %s · %s call(s)",
			len(runs), getStr(selected, "run_id"), callsLabel)
	}
	model := selected["model"]
	if len(events) > 0 {
		if first, ok := events[0].(map[string]any); ok {
			model = first["model"]
		}
	}
	wall := selected["wall_ms"]
	if wf, ok := num(wall); !ok || wf == 0 {
		if wall == nil || (ok && wf == 0) {
			wall = elapsed
		}
	}
	modelMS, _ := runModelMS(selected)
	var note any
	if modelOverlaps(selected) {
		note = modelOverlapNote
	}

	var liveState any
	if getStr(selected, "status") == "running" && hasRecords {
		liveState = muselog.LiveState(selectedRecords)
	}
	if liveState == nil && getStr(selected, "status") == "running" && claudeState != nil {
		liveState = *claudeState
	}

	var xray any = []any{}
	var intervals any = map[string]any{
		"intervals": []any{}, "unclosed_tools": []any{}, "unclosed_approvals": []any{}}
	if hasRecords {
		xray = muselog.InputTraces(selectedRecords)
		intervals = muselog.ToolIntervals(selectedRecords)
	}

	splitRun := clone(selected)
	splitRun["wall_ms"] = wall

	return map[string]any{
		"version": Version, "sessions": sessions,
		"selected": selected["run_id"], "file": file, "model": model,
		"prompt": selected["prompt"], "reply": selected["reply"],
		"provider":        selected["provider"],
		"harness_version": harnessVersion(selected),
		"model_ms":        modelMS, "model_note": note, "wall_ms": wall,
		"status": selected["status"], "elapsed_ms": elapsed,
		"live_state": liveState,
		"time_split": s.runSplit(splitRun, selectedRecords, hasRecords),
		"events":     events, "timeline": timeline, "errors": errs,
		"xray": xray, "intervals": intervals,
	}
}
