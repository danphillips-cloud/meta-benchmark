// Step 0 spike: embed web/ and serve muse-runs/index.jsonl read-only.
//
// Throwaway learning step (see .docs/plan-go-unix-wsl.md, step 0).
// No runner, no delete. The only API is a minimal GET /api/logs that
// mirrors lib/server.py read_logs() closely enough for the committed
// dashboard to render real history. Live-session enrichment from Muse
// session logs (retry merge, xray, computed time split) is left out.
package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// version mirrors lib/server.py VERSION at spike time (PR #83 merge).
const version = 78

const (
	defaultPort   = 8766
	forbiddenPort = 8765 // the user's own page, never probe or bind it
)

//go:embed web/index.html web/app.js web/style.css
var webFS embed.FS

func usePort() (int, int) {
	raw := os.Getenv("PORT")
	if raw == "" {
		return defaultPort, 0
	}
	port, err := strconv.Atoi(raw)
	if err != nil {
		fmt.Printf("PORT must be a whole number, got %q\n", raw)
		return 0, 2
	}
	if port < 0 || port > 65535 {
		fmt.Printf("PORT must be a whole number, got %q\n", raw)
		return 0, 2
	}
	if port == forbiddenPort {
		fmt.Printf("PORT %d is reserved for the Python page. Pick another port\n", forbiddenPort)
		return 0, 2
	}
	return port, 0
}

// resolveDataDir returns the muse-runs directory. META_BENCHMARK_HOME,
// when set, is the parent that holds muse-runs/. A value that itself
// holds index.jsonl is also accepted. Default is ./muse-runs.
func resolveDataDir() string {
	if home := os.Getenv("META_BENCHMARK_HOME"); home != "" {
		nested := filepath.Join(home, "muse-runs")
		if _, err := os.Stat(filepath.Join(nested, "index.jsonl")); err == nil {
			return nested
		}
		if _, err := os.Stat(filepath.Join(home, "index.jsonl")); err == nil {
			return home
		}
		return nested
	}
	return "muse-runs"
}

type handler struct {
	dataDir string
	port    int
}

func (h *handler) isLocal(r *http.Request) bool {
	host := r.Host
	if host != fmt.Sprintf("127.0.0.1:%d", h.port) && host != fmt.Sprintf("localhost:%d", h.port) {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		if origin != fmt.Sprintf("http://127.0.0.1:%d", h.port) && origin != fmt.Sprintf("http://localhost:%d", h.port) {
			return false
		}
	}
	return true
}

func send(w http.ResponseWriter, code int, body []byte, ctype string) {
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(code)
	_, _ = w.Write(body)
}

func (h *handler) sendWeb(w http.ResponseWriter, name, ctype string) {
	body, err := fs.ReadFile(webFS, "web/"+name)
	if err != nil {
		http.Error(w, "404 Not Found", http.StatusNotFound)
		return
	}
	send(w, http.StatusOK, body, ctype)
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.isLocal(r) {
		http.Error(w, "403 Forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "404 Not Found", http.StatusNotFound)
		return
	}
	switch r.URL.Path {
	case "/api/logs":
		body, err := json.Marshal(h.readLogs(r.URL.Query().Get("run")))
		if err != nil {
			http.Error(w, "500 Internal Server Error", http.StatusInternalServerError)
			return
		}
		send(w, http.StatusOK, body, "application/json")
	case "/app.js":
		h.sendWeb(w, "app.js", "text/javascript; charset=utf-8")
	case "/style.css":
		h.sendWeb(w, "style.css", "text/css; charset=utf-8")
	default:
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.Error(w, "404 Not Found", http.StatusNotFound)
			return
		}
		h.sendWeb(w, "index.html", "text/html; charset=utf-8")
	}
}

// --- index loading (mirrors lib/server.py load_runs, minus live calls) ---

type runMap map[string]any

func getStr(m runMap, key string) string {
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}

func getNum(m runMap, key string) (float64, bool) {
	return num(m[key])
}

func num(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case float64:
		return n, true
	}
	return 0, false
}

func getCalls(m runMap) []runMap {
	raw, ok := m["calls"].([]any)
	if !ok {
		return nil
	}
	calls := make([]runMap, 0, len(raw))
	for _, c := range raw {
		if cm, ok := c.(map[string]any); ok {
			calls = append(calls, runMap(cm))
		}
	}
	return calls
}

func parseAt(v any) (time.Time, bool) {
	s, ok := v.(string)
	if !ok || s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	// Naive values are UTC, same as lib/server.py _parse_at.
	for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05"} {
		if t, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func isStaleRunning(m runMap) bool {
	started, ok := parseAt(m["at"])
	if !ok {
		return false
	}
	timeout, ok := getNum(m, "timeout_seconds")
	if !ok || timeout == 0 {
		timeout = 1800
	}
	return time.Since(started).Seconds() > timeout+300
}

func (h *handler) loadRuns() []runMap {
	data, err := os.ReadFile(filepath.Join(h.dataDir, "index.jsonl"))
	if err != nil {
		return nil
	}
	var runs []runMap
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		dec := json.NewDecoder(bytes.NewReader(line))
		dec.UseNumber()
		var m map[string]any
		if err := dec.Decode(&m); err != nil {
			continue
		}
		runs = append(runs, runMap(m))
	}
	// Keep the last entry per run_id, in first-seen order like a
	// Python dict. A row with no run_id keeps its own slot.
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
		runID := getStr(r, "run_id")
		report := filepath.Join(h.dataDir, runID, "report.json")
		_, reportErr := os.Stat(report)
		if getStr(r, "status") == "running" && reportErr != nil && isStaleRunning(r) {
			r = clone(r)
			r["status"] = "interrupted"
		}
		if getStr(r, "provider") == "muse-retro" || getStr(r, "provider") == "muse-watch" {
			if rec, ok := r["outcome_recorded"].(bool); !ok || !rec {
				r = clone(r)
				r["status"] = "unknown"
			}
		}
		fixed = append(fixed, r)
	}
	return fixed
}

func clone(m runMap) runMap {
	out := make(runMap, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// --- derived fields (mirrors lib/server.py _run_model_ms and friends) ---

const modelOverlapNote = "A model call started before this turn, so model time can't be set against wall"

func modelOverlaps(r runMap) bool {
	if b, ok := r["calls_started_before_turn"].(bool); ok && b {
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

// runModelMS returns (value, present). Absent means render a dash.
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
		"tool_ms":       r["tool_ms"], "approval_ms": r["approval_ms"], "muse_ms": r["muse_ms"],
		"last_input_tokens":  callInputTokens(r, lastCall),
		"last_output_tokens": lastCall["output_tokens"],
	}
}

func runSplit(r runMap) map[string]any {
	modelMS, _ := runModelMS(r)
	// Spike: no session-log reading, so only a stored split is used.
	if r["tool_ms"] != nil || r["approval_ms"] != nil || r["muse_ms"] != nil {
		return map[string]any{"model_ms": modelMS, "tool_ms": r["tool_ms"],
			"approval_ms": r["approval_ms"], "muse_ms": r["muse_ms"]}
	}
	return map[string]any{"model_ms": modelMS, "tool_ms": nil, "approval_ms": nil, "muse_ms": nil}
}

// --- /api/logs (mirrors lib/server.py read_logs, historical runs only) ---

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

func validRunID(id string) bool {
	if id == "" || strings.ContainsAny(id, "/\\") || id == "." || id == ".." {
		return false
	}
	return true
}

func (h *handler) readLogs(runID string) map[string]any {
	runs := h.loadRuns()
	sessions := make([]any, 0, len(runs))
	for i := len(runs) - 1; i >= 0; i-- {
		sessions = append(sessions, sessionRow(runs[i]))
	}
	selected := pickSelected(runs, runID)
	calls := getCalls(selected)

	var elapsed any
	if getStr(selected, "status") == "running" {
		if started, ok := parseAt(selected["at"]); ok {
			elapsed = float64(time.Since(started).Milliseconds())
		}
	}

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
	if mu, _ := selected["metrics_unavailable"].(bool); mu && getStr(selected, "provider") != "echo" {
		errs = append(errs, map[string]any{"at": selected["at"],
			"operation":  selected["run_id"],
			"error_type": "model metrics unavailable for this run"})
	}
	if len(errs) > 3 {
		errs = errs[len(errs)-3:]
	}

	// Timeline comes from the selected run's report.json, on demand.
	timeline := []any{}
	if id := getStr(selected, "run_id"); validRunID(id) {
		if data, err := os.ReadFile(filepath.Join(h.dataDir, id, "report.json")); err == nil {
			dec := json.NewDecoder(bytes.NewReader(data))
			dec.UseNumber()
			var full map[string]any
			if err := dec.Decode(&full); err == nil {
				if tl, ok := full["timeline"].([]any); ok {
					for _, item := range tl {
						tm, ok := item.(map[string]any)
						if !ok {
							continue
						}
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
				}
			}
		}
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
	var model any = selected["model"]
	if len(events) > 0 {
		if first, ok := events[0].(map[string]any); ok {
			model = first["model"]
		}
	}
	wall := selected["wall_ms"]
	if wf, ok := num(wall); !ok || wf == 0 {
		// Python uses `or`, so a missing or zero wall falls back.
		if wall == nil || (ok && wf == 0) {
			wall = elapsed
		}
	}
	modelMS, _ := runModelMS(selected)
	var note any
	if modelOverlaps(selected) {
		note = modelOverlapNote
	}
	splitRun := clone(selected)
	splitRun["wall_ms"] = wall

	return map[string]any{
		"version": version, "sessions": sessions,
		"selected": selected["run_id"], "file": file, "model": model,
		"prompt": selected["prompt"], "reply": selected["reply"],
		"provider":        selected["provider"],
		"harness_version": harnessVersion(selected),
		"model_ms":        modelMS, "model_note": note, "wall_ms": wall,
		"status": selected["status"], "elapsed_ms": elapsed,
		"live_state": nil, "time_split": runSplit(splitRun),
		"events": events, "timeline": timeline, "errors": errs,
		"xray": []any{},
		"intervals": map[string]any{"intervals": []any{},
			"unclosed_tools": []any{}, "unclosed_approvals": []any{}},
	}
}

func main() {
	port, code := usePort()
	if code != 0 {
		os.Exit(code)
	}
	h := &handler{dataDir: resolveDataDir(), port: port}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		fmt.Println("Could not start the spike server:", err)
		os.Exit(1)
	}
	// PORT=0 picks a free port. Report the real one and check Host
	// against it, not against zero.
	if addr, ok := ln.Addr().(*net.TCPAddr); ok {
		h.port = addr.Port
	}
	fmt.Printf("UI: http://127.0.0.1:%d/\n", h.port)
	if err := http.Serve(ln, h); err != nil {
		fmt.Println("Spike server stopped:", err)
		os.Exit(1)
	}
}
