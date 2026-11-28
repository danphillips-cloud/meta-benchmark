package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"

	"meta-benchmark/internal/muselog"
	"meta-benchmark/internal/report"
)

func fmtBucket(ms *float64) string {
	if ms == nil {
		return "–"
	}
	return fmt.Sprintf("%.1f s", *ms/1000)
}

// RecordWatchTurn appends one finished interactive turn as a run.
func (r *Runner) RecordWatchTurn(turn muselog.Turn, sessionID, provider, command string, quiet bool) (report.Report, error) {
	runID, runDir, err := r.newRunDir()
	if err != nil {
		return report.Report{}, err
	}
	rep, err := r.writeTurn(turn, sessionID, provider, command, runID, runDir)
	if err != nil {
		return rep, err
	}
	if !quiet {
		out := r.Out
		if out == nil {
			out = os.Stdout
		}
		fmt.Fprintf(out, "turn %d · wall %.1f s · model %s · tools %s · approval %s · Muse %s · %d call(s)\n",
			turn.Index, float64(turn.WallMS)/1000, fmtBucket(turn.Split.ModelMS),
			fmtBucket(turn.Split.ToolMS), fmtBucket(turn.Split.ApprovalMS),
			fmtBucket(turn.Split.MuseMS), len(turn.Calls))
	}
	return rep, nil
}

// writeTurn writes one turn's report under runID. Shared by a
// fresh import and by a repair, so both record the same fields.
func (r *Runner) writeTurn(turn muselog.Turn, sessionID, provider, command, runID, runDir string) (report.Report, error) {
	if err := os.WriteFile(filepath.Join(runDir, "prompt.md"), []byte(turn.Prompt), 0o644); err != nil {
		return report.Report{}, err
	}
	at := turn.At
	status := turn.Status
	if status == "" {
		status = "unknown"
	}
	outcome := status != "unknown"
	wall := float64(turn.WallMS)
	turnIndex := turn.Index
	early := turn.CallsStartedBeforeTurn
	contextMode := "interactive"
	rep := report.Report{
		At: &at, RunID: &runID, Prompt: turn.Prompt, Model: turn.Model,
		Provider: &provider, SessionID: &sessionID, ContextMode: &contextMode,
		HarnessVersion: turn.Version, ToolMS: turn.Split.ToolMS,
		ApprovalMS: turn.Split.ApprovalMS, MuseMS: turn.Split.MuseMS,
		Status: &status, OutcomeRecorded: &outcome, Command: &command,
		WallMS: &wall, Calls: ToReportCalls(turn.Calls),
		Timeline:  ToReportTimeline(turn.Timeline),
		TurnIndex: &turnIndex, CallsStartedBeforeTurn: &early,
	}
	if rep.Timeline == nil {
		rep.Timeline = []report.TimelineRow{}
	}
	if err := r.WriteRun(runDir, rep); err != nil {
		return rep, err
	}
	return rep, nil
}

// RunWatch attaches read-only to a Muse session and records
// its turns. It never starts, stops, or answers Muse.
func (r *Runner) RunWatch(ctx context.Context, sessionArg string) {
	out := r.Out
	if out == nil {
		out = os.Stdout
	}
	errOut := r.ErrOut
	if errOut == nil {
		errOut = os.Stderr
	}
	var path, sessionID string
	if sessionArg != "" {
		sessionID = sessionArg
		path, _ = muselog.SessionLogPath(sessionArg)
	} else {
		path, _ = muselog.NewestSessionPath()
		if path != "" {
			sessionID = filepath.Base(filepath.Dir(path))
		}
	}
	if path == "" {
		fmt.Fprintln(errOut, "No Muse session log found to watch.")
		return
	}
	if _, err := os.Stat(path); err != nil {
		fmt.Fprintln(errOut, "No Muse session log found to watch.")
		return
	}
	fmt.Fprintf(out, "Watching session %s read-only. Run Muse normally in another terminal. Ctrl+C stops watching.%s\n",
		sessionID, r.UISuffix())
	recorded := map[int]bool{}
	sweep := func() []muselog.Record {
		records := muselog.ReadRecords(path)
		for _, turn := range muselog.SplitTurns(records) {
			if !recorded[turn.Index] {
				recorded[turn.Index] = true
				_, _ = r.RecordWatchTurn(turn, sessionID, "muse-watch", "./run-muse --watch", false)
			}
		}
		return records
	}
	for {
		records := sweep()
		ended := false
		for _, e := range records {
			if e["payload_type"] == "session.end" {
				ended = true
			}
		}
		if ended {
			fmt.Fprintln(out, "Session ended.")
			return
		}
		select {
		case <-ctx.Done():
			// Only turns closed since the last poll can land here.
			sweep()
			fmt.Fprintln(out, "\nStopped watching.")
			return
		case <-time.After(time.Second):
		}
	}
}

var turnProviders = map[string]bool{"muse-watch": true, "muse-retro": true}

// indexEntries reads every parseable index entry.
func (r *Runner) indexEntries() []map[string]any {
	data, err := os.ReadFile(filepath.Join(r.DataDir, "index.jsonl"))
	if err != nil {
		return nil
	}
	var entries []map[string]any
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var m map[string]any
		dec := json.NewDecoder(bytes.NewReader(line))
		dec.UseNumber()
		if err := dec.Decode(&m); err == nil {
			entries = append(entries, m)
		}
	}
	return entries
}

// SessionTurns pairs a session id with its finished turns.
type SessionTurns struct {
	SessionID string
	Turns     []muselog.Turn
}

// PlannedTurn is one (session, turn) retro import candidate.
type PlannedTurn struct {
	SessionID string
	Turn      muselog.Turn
}

// RetroPlan returns turns still missing from the index. A
// session recorded by the launcher is skipped whole. A turn
// recorded by watch or an earlier retro run is skipped by
// (session_id, turn_index).
func RetroPlan(entries []map[string]any, sessions []SessionTurns) []PlannedTurn {
	owned := map[string]bool{}
	seen := map[[2]string]bool{}
	for _, e := range entries {
		sid, _ := e["session_id"].(string)
		if sid == "" {
			continue
		}
		provider, _ := e["provider"].(string)
		if !turnProviders[provider] {
			owned[sid] = true
		} else {
			seen[[2]string{sid, turnIndexKey(e["turn_index"])}] = true
		}
	}
	var plan []PlannedTurn
	for _, session := range sessions {
		if owned[session.SessionID] {
			continue
		}
		for _, turn := range session.Turns {
			key := [2]string{session.SessionID, fmt.Sprint(turn.Index)}
			if !seen[key] {
				plan = append(plan, PlannedTurn{SessionID: session.SessionID, Turn: turn})
			}
		}
	}
	return plan
}

func turnIndexKey(v any) string {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return fmt.Sprint(i)
		}
		return n.String()
	case float64:
		return fmt.Sprint(int64(n))
	case nil:
		return "<nil>"
	}
	return fmt.Sprint(v)
}

// Repair pairs an imported entry with the turn that now has an
// explicit outcome for it.
type Repair struct {
	Entry map[string]any
	Turn  muselog.Turn
}

// RetroRepairs finds imported turns with no recorded outcome
// where the log now gives an explicit one.
func RetroRepairs(entries []map[string]any, sessions []SessionTurns) []Repair {
	latest := map[string]map[string]any{}
	for _, e := range entries {
		if id, _ := e["run_id"].(string); id != "" {
			latest[id] = e
		}
	}
	byKey := map[[2]string]muselog.Turn{}
	for _, session := range sessions {
		for _, turn := range session.Turns {
			byKey[[2]string{session.SessionID, fmt.Sprint(turn.Index)}] = turn
		}
	}
	var repairs []Repair
	// Keep index order for determinism. Python iterates the
	// latest dict in first-seen run_id order.
	seenIDs := map[string]bool{}
	for _, e := range entries {
		id, _ := e["run_id"].(string)
		if id == "" || seenIDs[id] {
			continue
		}
		seenIDs[id] = true
		entry := latest[id]
		provider, _ := entry["provider"].(string)
		if !turnProviders[provider] {
			continue
		}
		if recorded, isBool := entry["outcome_recorded"].(bool); isBool && recorded {
			continue
		}
		sid, _ := entry["session_id"].(string)
		turn, found := byKey[[2]string{sid, turnIndexKey(entry["turn_index"])}]
		if found && turn.Status != "" && turn.Status != "unknown" {
			repairs = append(repairs, Repair{Entry: entry, Turn: turn})
		}
	}
	return repairs
}

// ListSessionLogs returns every session log path, sorted.
func ListSessionLogs() []string {
	var files []string
	_ = filepath.WalkDir(muselog.SessionsDir(), func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() == "session.jsonl" {
			files = append(files, path)
		}
		return nil
	})
	sort.Strings(files)
	return files
}

// RunRetro records finished turns from every Muse session
// log on disk. Read-only on the logs.
func (r *Runner) RunRetro() {
	out := r.Out
	if out == nil {
		out = os.Stdout
	}
	files := ListSessionLogs()
	if len(files) == 0 {
		fmt.Fprintln(out, "No Muse session logs found.")
		return
	}
	type sessionInfo struct {
		first     int64
		sessionID string
		turns     []muselog.Turn
	}
	var sessions []sessionInfo
	seenIDs := map[string]bool{}
	for _, path := range files {
		sessionID := filepath.Base(filepath.Dir(path))
		if seenIDs[sessionID] {
			continue
		}
		seenIDs[sessionID] = true
		records := muselog.ReadRecords(path)
		turns := muselog.SplitTurns(records)
		if len(turns) == 0 {
			continue
		}
		var first int64
		foundFirst := false
		for _, e := range records {
			if ts, ok := recordTS(e); ok && (!foundFirst || ts < first) {
				first, foundFirst = ts, true
			}
		}
		sessions = append(sessions, sessionInfo{first, sessionID, turns})
	}
	sort.SliceStable(sessions, func(i, j int) bool {
		if sessions[i].first != sessions[j].first {
			return sessions[i].first < sessions[j].first
		}
		return sessions[i].sessionID < sessions[j].sessionID
	})
	entries := r.indexEntries()
	bySession := make([]SessionTurns, 0, len(sessions))
	for _, s := range sessions {
		bySession = append(bySession, SessionTurns{s.sessionID, s.turns})
	}
	repairs := RetroRepairs(entries, bySession)
	for _, repair := range repairs {
		runID, _ := repair.Entry["run_id"].(string)
		runDir := filepath.Join(r.DataDir, runID)
		_ = os.MkdirAll(runDir, 0o755)
		provider, _ := repair.Entry["provider"].(string)
		command, _ := repair.Entry["command"].(string)
		if command == "" {
			command = "./run-muse --retro"
		}
		sid, _ := repair.Entry["session_id"].(string)
		_, _ = r.writeTurn(repair.Turn, sid, provider, command, runID, runDir)
	}
	if len(repairs) > 0 {
		fmt.Fprintf(out, "Repaired %d earlier turn(s) that had no recorded outcome.\n", len(repairs))
	}
	plan := RetroPlan(entries, bySession)
	planned := map[string]int{}
	for _, p := range plan {
		planned[p.SessionID]++
	}
	candidates := 0
	for _, s := range sessions {
		candidates += len(s.turns)
	}
	for _, s := range sessions {
		if imported := planned[s.sessionID]; imported > 0 {
			fmt.Fprintf(out, "session %s: imported %d turn(s), skipped %d\n",
				s.sessionID, imported, len(s.turns)-imported)
		}
	}
	for _, p := range plan {
		_, _ = r.RecordWatchTurn(p.Turn, p.SessionID, "muse-retro", "./run-muse --retro", true)
	}
	fmt.Fprintf(out, "Retro done. Imported %d turn(s) from %d session(s). Skipped %d turn(s) already recorded.%s\n",
		len(plan), len(planned), candidates-len(plan), r.UISuffix())
}

func recordTS(e muselog.Record) (int64, bool) {
	switch n := e["recorded_at"].(type) {
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	case float64:
		return int64(n), true
	}
	return 0, false
}
