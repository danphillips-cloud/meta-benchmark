// Package runner ports the run_prompt core of run-muse:
// registering a run, driving one provider, and recording the
// final report. Step 4 covers the Muse paths (meta and echo).
// Other providers land in step 5 and are refused plainly here.
package runner

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"meta-benchmark/internal/indexlock"
	"meta-benchmark/internal/muselog"
	"meta-benchmark/internal/pricing"
	"meta-benchmark/internal/report"
)

// Checks are explicit deterministic task checks. No model
// judging or shell execution.
type Checks struct {
	ReplyContains []string
	FilesExist    []string
}

// Options selects how one prompt runs.
type Options struct {
	Provider     string
	Model        string
	Minimal      bool
	Timeout      *int
	ComparisonID *string
	Round        *int
	CompareMode  *string
	SuiteID      *string
	SuitePrompt  *string
	Raced        bool
	Pricing      map[string]Rates
	Checks       *Checks
	// LegLabel prefixes live lines for raced compare legs.
	LegLabel string
}

// MuseExecFunc runs one Muse prompt. Injectable for tests.
type MuseExecFunc func(ctx context.Context, prompt, runDir, provider, model string,
	minimal bool, timeoutSeconds int, sessionID, legLabel string, out io.Writer) Result

// ClaudeExecFunc runs one Claude Code prompt.
type ClaudeExecFunc func(ctx context.Context, prompt, runDir, model string,
	timeoutSeconds int, legLabel string, out io.Writer) Result

// AnthropicExecFunc runs one direct API prompt.
type AnthropicExecFunc func(ctx context.Context, prompt, runDir, model string,
	timeoutSeconds int) Result

// CodexExecFunc runs one Codex prompt.
type CodexExecFunc func(ctx context.Context, prompt, runDir, model string,
	minimal bool, timeoutSeconds int, out io.Writer) Result

// Runner records runs under DataDir.
type Runner struct {
	DataDir   string
	Out       io.Writer
	ErrOut    io.Writer
	UIURL     string
	UIEnabled bool

	MuseExec         MuseExecFunc
	ClaudeExec       ClaudeExecFunc
	AnthropicExec    AnthropicExecFunc
	CodexExec        CodexExecFunc
	HarnessVersionFn func(provider string) *string
	AllowanceStartFn func() *pricing.Allowance
	Now              func() time.Time
}

// New returns a Runner writing to stdout and stderr.
func New(dataDir string) *Runner {
	return &Runner{
		DataDir: dataDir, Out: os.Stdout, ErrOut: os.Stderr,
		MuseExec: RunMuseExec, ClaudeExec: RunClaudeCode,
		AnthropicExec: RunAnthropic, CodexExec: RunCodex,
		HarnessVersionFn: HarnessVersion,
		AllowanceStartFn: func() *pricing.Allowance { return CaptureAllowanceStart(nil) },
		Now:              time.Now,
	}
}

func (r *Runner) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func isoTime(t time.Time) string {
	u := t.UTC()
	if u.Nanosecond() == 0 {
		return u.Format("2006-01-02T15:04:05+00:00")
	}
	return u.Format("2006-01-02T15:04:05.000000+00:00")
}

func newUUID() string {
	var b [16]byte
	if _, err := cryptorand.Read(b[:]); err != nil {
		now := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(now >> (8 * (i % 8)))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (r *Runner) newRunDir() (string, string, error) {
	if err := os.MkdirAll(r.DataDir, 0o755); err != nil {
		return "", "", err
	}
	for {
		var suffix [3]byte
		if _, err := cryptorand.Read(suffix[:]); err != nil {
			return "", "", err
		}
		runID := r.now().Format("20060102-150405") + "-" + hex.EncodeToString(suffix[:])
		dir := filepath.Join(r.DataDir, runID)
		err := os.Mkdir(dir, 0o755)
		if err == nil {
			return runID, dir, nil
		}
		if !os.IsExist(err) {
			return "", "", err
		}
	}
}

func (r *Runner) appendIndex(value any) error {
	body, err := marshalJSON(value)
	if err != nil {
		return err
	}
	indexPath := filepath.Join(r.DataDir, "index.jsonl")
	return indexlock.Lock(indexPath, func() error {
		f, err := os.OpenFile(indexPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o666)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = f.Write(append(body, '\n'))
		return err
	})
}

func marshalJSON(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func marshalIndent(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// WriteRun writes report.json and appends the summary line,
// exactly like run-muse write_run.
func (r *Runner) WriteRun(runDir string, rep report.Report) error {
	body, err := marshalIndent(rep)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(runDir, "report.json"), body, 0o644); err != nil {
		return err
	}
	summaryRaw, err := marshalJSON(rep)
	if err != nil {
		return err
	}
	var summary map[string]any
	if err := json.Unmarshal(summaryRaw, &summary); err != nil {
		return err
	}
	delete(summary, "timeline")
	return r.appendIndex(summary)
}

// RunStatus maps a provider result onto a run status.
func RunStatus(result Result) string {
	if result.NeedsApproval != nil && *result.NeedsApproval != "" {
		return "needs_approval"
	}
	if result.TimedOut {
		return "timeout"
	}
	if result.Interrupted {
		return "interrupted"
	}
	if result.ExitCode != 0 {
		return "failed"
	}
	return "completed"
}

// ExitCodeFor maps a run status onto a process exit code.
func ExitCodeFor(status string) int {
	switch status {
	case "completed":
		return 0
	case "interrupted":
		return 130
	default:
		return 1
	}
}

// ValidateTask runs the explicit checks for one finished run.
func ValidateTask(checks *Checks, reply, runDir, status string) *report.TaskValidation {
	if checks == nil {
		return &report.TaskValidation{Status: "not_checked", Checks: []report.TaskCheck{}}
	}
	if status != "completed" {
		reason := "Execution did not complete"
		return &report.TaskValidation{
			Status: "not_checked", Checks: []report.TaskCheck{}, Reason: &reason}
	}
	outcomes := []report.TaskCheck{}
	for _, text := range checks.ReplyContains {
		outcomes = append(outcomes, report.TaskCheck{
			Check: "reply_contains", Value: text, Passed: strings.Contains(reply, text)})
	}
	workspace, _ := filepath.Abs(filepath.Join(runDir, "workspace"))
	if resolved, err := filepath.EvalSymlinks(workspace); err == nil {
		workspace = resolved
	}
	for _, name := range checks.FilesExist {
		passed := false
		target := filepath.Join(workspace, name)
		if resolved, err := filepath.EvalSymlinks(target); err == nil {
			target = resolved
		} else {
			target = filepath.Clean(target)
		}
		if strings.HasPrefix(target, workspace+string(os.PathSeparator)) {
			if info, err := os.Stat(target); err == nil && !info.IsDir() {
				passed = true
			}
		}
		outcomes = append(outcomes, report.TaskCheck{
			Check: "files_exist", Value: name, Passed: passed})
	}
	statusOut := "passed"
	for _, o := range outcomes {
		if !o.Passed {
			statusOut = "failed"
			break
		}
	}
	return &report.TaskValidation{Status: statusOut, Checks: outcomes}
}

func toReportAllowance(a *pricing.Allowance) *report.Allowance {
	if a == nil {
		return nil
	}
	convert := func(w *pricing.Window) *report.AllowanceWindow {
		if w == nil {
			return nil
		}
		return &report.AllowanceWindow{UsedPercent: w.UsedPercent, ResetsAtMS: w.ResetsAtMS}
	}
	return &report.Allowance{Window: convert(a.Window), Weekly: convert(a.Weekly)}
}

func pyNum(v float64) string {
	if v == float64(int64(v)) {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

func trimPercent(v float64) string { return pyNum(v) }

func planUsageText(rep report.Report) string {
	parts := []string{}
	buckets := []struct {
		label string
		moved *float64
		start *report.AllowanceWindow
		end   *report.AllowanceWindow
	}{}
	var deltaWin, deltaWeek *float64
	if rep.AllowanceDelta != nil {
		deltaWin, deltaWeek = rep.AllowanceDelta.Window, rep.AllowanceDelta.Weekly
	}
	var startWin, startWeek, endWin, endWeek *report.AllowanceWindow
	if rep.AllowanceStart != nil {
		startWin, startWeek = rep.AllowanceStart.Window, rep.AllowanceStart.Weekly
	}
	if rep.AllowanceEnd != nil {
		endWin, endWeek = rep.AllowanceEnd.Window, rep.AllowanceEnd.Weekly
	}
	buckets = append(buckets,
		struct {
			label string
			moved *float64
			start *report.AllowanceWindow
			end   *report.AllowanceWindow
		}{"short-term", deltaWin, startWin, endWin},
		struct {
			label string
			moved *float64
			start *report.AllowanceWindow
			end   *report.AllowanceWindow
		}{"weekly", deltaWeek, startWeek, endWeek})
	for _, b := range buckets {
		if b.moved == nil {
			continue
		}
		amount := "under 1%"
		if *b.moved != 0 {
			amount = trimPercent(*b.moved) + "%"
		}
		text := amount + " of " + b.label + " limit"
		if b.start != nil && b.end != nil &&
			b.start.UsedPercent != nil && b.end.UsedPercent != nil {
			text += fmt.Sprintf(" (%s→%s%%)",
				trimPercent(*b.start.UsedPercent), trimPercent(*b.end.UsedPercent))
		}
		parts = append(parts, text)
	}
	if len(parts) == 0 {
		return ""
	}
	return " · Muse plan: used " + strings.Join(parts, ", ")
}

// UISuffix renders the trailing UI pointer, or nothing when
// the UI is off. The prompt loop banner uses it.
func (r *Runner) UISuffix() string {
	if !r.UIEnabled {
		return ""
	}
	return " UI: " + r.UIURL
}

// PrintSummary prints the one-line terminal summary. Strict
// totals: one missing call value makes the total a dash.
func (r *Runner) PrintSummary(rep report.Report, result Result, runDir string) {
	out := r.Out
	if out == nil {
		out = os.Stdout
	}
	errOut := r.ErrOut
	if errOut == nil {
		errOut = os.Stderr
	}
	status := ""
	if rep.Status != nil {
		status = *rep.Status
	}
	label := strVal(rep.Provider) + "/" + strVal(rep.Model)
	allowText := planUsageText(rep)
	if rep.MetricsUnavailable {
		fmt.Fprintf(out, "[%s] wall %d ms · model metrics unavailable (no model records in session log)%s\n",
			label, result.WallMS, allowText)
	} else {
		var modelMS *float64
		if len(result.Calls) > 0 {
			sum := 0.0
			all := true
			for _, c := range result.Calls {
				if c.DurationMS == nil {
					all = false
					break
				}
				sum += *c.DurationMS
			}
			if all {
				modelMS = &sum
			}
		}
		if modelMS == nil {
			modelMS = result.APIMS
		}
		modelText := "–"
		if modelMS != nil {
			modelText = pyNum(*modelMS) + " ms"
		}
		summed := func(get func(report.Call) *int64) *int64 {
			if len(result.Calls) == 0 {
				return nil
			}
			var sum int64
			for _, c := range result.Calls {
				v := get(c)
				if v == nil {
					return nil
				}
				sum += *v
			}
			return &sum
		}
		var inTok, outTok *int64
		if result.Totals != nil {
			inTok, outTok = result.Totals.Input, result.Totals.Output
		} else {
			inTok = summed(func(c report.Call) *int64 { return c.InputTokens })
			outTok = summed(func(c report.Call) *int64 { return c.OutputTokens })
		}
		inText, outText := "–", "–"
		if inTok != nil {
			inText = strconv.FormatInt(*inTok, 10)
		}
		if outTok != nil {
			outText = strconv.FormatInt(*outTok, 10)
		}
		costText := ""
		if shown := CountedCost(strVal(rep.Model), rep.CostUSD, rep.CostSource); shown != nil {
			costText = fmt.Sprintf(" · cost $%.4f", *shown)
			switch strVal(rep.CostSource) {
			case "computed":
				costText += " (at your rates)"
			case "list":
				costText += " (at Meta list)"
			}
		}
		callText := strconv.Itoa(len(result.Calls))
		if strVal(rep.Provider) == "codex" {
			callText = "–"
		}
		fmt.Fprintf(out, "[%s] wall %d ms · model %s · in %s · out %s · %s call(s)%s%s · %s\n",
			label, result.WallMS, modelText, inText, outText, callText, costText, allowText, status)
	}
	if rep.TaskValidation != nil && rep.TaskValidation.Status != "" {
		fmt.Fprintf(out, "Task checks: %s\n", strings.ReplaceAll(rep.TaskValidation.Status, "_", " "))
	}
	if result.Reply != "" {
		runes := []rune(result.Reply)
		shownRunes := runes
		if len(runes) > 500 {
			shownRunes = runes[:500]
		}
		shown := string(shownRunes)
		if len(runes) > 500 && !unicode.IsSpace(runes[500]) && strings.Contains(shown, " ") {
			shown = shown[:strings.LastIndex(shown, " ")]
		}
		fmt.Fprintln(out, shown)
		if len(runes) > 500 {
			fmt.Fprintf(out, "… (full reply: muse-runs/%s/report.json)\n", strVal(rep.RunID))
		}
	}
	workspace := filepath.Join(runDir, "workspace")
	switch {
	case status == "needs_approval":
		fmt.Fprintf(out, "WARNING: stopped. Waiting for approval: %s. The run was stopped at once instead of waiting. Partial files are in %s\n",
			strVal(result.NeedsApproval), workspace)
	case status == "timeout":
		fmt.Fprintf(out, "Timed out after %d seconds. That is the run cap, not a crash. Partial files are in %s\n",
			intVal(rep.TimeoutSeconds), workspace)
	case status == "interrupted":
		fmt.Fprintf(out, "Interrupted. The run was stopped and recorded. Partial files are in %s\n", workspace)
	case rep.Error != nil && *rep.Error != "":
		fmt.Fprintf(errOut, "error: %s\n", *rep.Error)
	}
	if r.UIEnabled {
		fmt.Fprintf(out, "UI: %s  (run %s)\n", r.UIURL, strVal(rep.RunID))
	}
}

func strVal(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func intVal(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// RunPrompt runs one prompt and records it, mirroring
// run-muse run_prompt for every provider.
func (r *Runner) RunPrompt(ctx context.Context, prompt string, opts Options) (report.Report, error) {
	provider := opts.Provider
	if provider == "" {
		provider = DefaultProvider()
	}
	model, err := ResolveModel(provider, opts.Model)
	if err != nil {
		return report.Report{}, err
	}
	timeout := DefaultTimeout(provider)
	if opts.Timeout != nil {
		timeout = *opts.Timeout
	}
	out := r.Out
	if out == nil {
		out = os.Stdout
	}
	if provider == "codex" {
		printMu.Lock()
		fmt.Fprintln(out, "Codex run: may consume subscription usage or bill an API key. Cost is not recorded.")
		printMu.Unlock()
	}
	if isPaid(provider) {
		printMu.Lock()
		fmt.Fprintln(out, PaidNotice(model))
		printMu.Unlock()
	}
	runID, runDir, err := r.newRunDir()
	if err != nil {
		return report.Report{}, err
	}
	var liveSessionID *string
	if IsMuse(provider) {
		id := newUUID()
		liveSessionID = &id
	}
	contextMode := "full"
	if opts.Minimal {
		contextMode = "minimal"
	}
	if provider == "claude-code" {
		contextMode = "bare"
	}
	version := r.HarnessVersionFn(provider)
	var allowanceStart *pricing.Allowance
	if IsMuse(provider) && provider != "echo" && r.AllowanceStartFn != nil {
		allowanceStart = r.AllowanceStartFn()
	}
	startedAt := isoTime(r.now())
	recorded := recordedModel(provider, model)
	running := map[string]any{
		"at": startedAt, "allowance_start": toReportAllowance(allowanceStart),
		"run_id": runID, "prompt": prompt, "model": recorded,
		"provider": provider, "session_id": strOrNilVal(liveSessionID),
		"context_mode": contextMode, "comparison_id": strOrNilVal(opts.ComparisonID),
		"round": intOrNil(opts.Round), "compare_mode": strOrNilVal(opts.CompareMode),
		"raced": opts.Raced, "suite_id": strOrNilVal(opts.SuiteID),
		"suite_prompt": strOrNilVal(opts.SuitePrompt), "harness_version": strOrNilVal(version),
		"status": "running", "timeout_seconds": timeout, "command": nil,
		"wall_ms": nil, "exit_code": nil, "reply": "", "calls": []any{},
		"metrics_unavailable": false, "error": nil,
	}
	if err := r.appendIndex(running); err != nil {
		return report.Report{}, err
	}
	started := time.Now()
	sessionArg := ""
	if liveSessionID != nil {
		sessionArg = *liveSessionID
	}
	legLabel := opts.LegLabel
	if opts.Raced {
		legLabel = provider + "/" + recorded
	}
	var result Result
	switch provider {
	case "codex":
		result = r.CodexExec(ctx, prompt, runDir, model, opts.Minimal, timeout, r.Out)
	case "anthropic":
		result = r.AnthropicExec(ctx, prompt, runDir, model, timeout)
	case "claude-code":
		result = r.ClaudeExec(ctx, prompt, runDir, model, timeout, legLabel, r.Out)
	default:
		result = r.MuseExec(ctx, prompt, runDir, provider, model, opts.Minimal,
			timeout, sessionArg, legLabel, r.Out)
	}
	select {
	case <-ctx.Done():
		if !result.Interrupted && ctx.Err() != nil {
			// Ctrl+C outside the process wait still records a
			// final interrupted status below.
			result.Interrupted = true
			if result.ExitCode == 0 {
				result.ExitCode = 130
			}
			if result.WallMS == 0 {
				result.WallMS = pyRoundMS(time.Since(started))
			}
		}
	default:
	}
	status := RunStatus(result)
	validation := ValidateTask(opts.Checks, result.Reply, runDir, status)
	stderrTail := ""
	if data, err := os.ReadFile(filepath.Join(runDir, "stderr.log")); err == nil {
		trimmed := strings.TrimSpace(string(data))
		if trimmed != "" {
			lines := strings.Split(trimmed, "\n")
			stderrTail = lines[len(lines)-1]
		}
	}
	var split muselog.Split
	hasSplit := false
	if result.SessionID != nil && IsMuse(provider) {
		if path, ok := muselog.SessionLogPath(*result.SessionID); ok {
			var modelSum *float64
			if len(result.Calls) > 0 {
				sum := 0.0
				all := true
				for _, c := range result.Calls {
					if c.DurationMS == nil {
						all = false
						break
					}
					sum += *c.DurationMS
				}
				if all {
					modelSum = &sum
				}
			}
			wall := float64(result.WallMS)
			split = muselog.TimeSplit(muselog.ReadRecords(path), &wall, modelSum)
			hasSplit = true
		}
	}
	finishedAt := isoTime(r.now())
	finalModel := recorded
	if result.UsageModel != nil && *result.UsageModel != "" {
		finalModel = *result.UsageModel
	}
	rep := report.Report{
		Prompt: "", Reply: "", Calls: []report.Call{}, Timeline: []report.TimelineRow{},
	}
	rep.At = &startedAt
	rep.FinishedAt = &finishedAt
	rep.RunID = &runID
	rep.Prompt = prompt
	rep.Model = &finalModel
	rep.Provider = &provider
	rep.SessionID = result.SessionID
	rep.ContextMode = &contextMode
	rep.ComparisonID = opts.ComparisonID
	rep.Round = opts.Round
	rep.CompareMode = opts.CompareMode
	rep.Raced = opts.Raced
	rep.SuiteID = opts.SuiteID
	rep.SuitePrompt = opts.SuitePrompt
	rep.RequestedModel = &model
	rep.HarnessVersion = version
	if hasSplit {
		rep.ToolMS, rep.ApprovalMS, rep.MuseMS = split.ToolMS, split.ApprovalMS, split.MuseMS
	}
	rep.NeedsApprovalTool = result.NeedsApproval
	rep.Status = &status
	rep.TaskValidation = validation
	rep.TimeoutSeconds = &timeout
	rep.Command = result.Command
	wall := float64(result.WallMS)
	rep.WallMS = &wall
	rep.ExitCode = &result.ExitCode
	rep.Reply = result.Reply
	rep.Calls = result.Calls
	rep.Timeline = result.Timeline
	rep.APIMS = result.APIMS
	rep.TTFTMS = result.TTFTMS
	rep.NumTurns = intPtrFrom(result.NumTurns)
	rep.CostUSD = result.CostUSD
	rep.AllowanceStart = toReportAllowance(allowanceStart)
	rep.AllowanceEnd = toReportAllowance(result.AllowanceEnd)
	if allowanceStart != nil || result.AllowanceEnd != nil {
		delta := pricing.AllowanceDelta(allowanceStart, result.AllowanceEnd)
		rep.AllowanceDelta = &report.AllowanceDelta{Window: delta.Window, Weekly: delta.Weekly}
	}
	if result.Totals != nil {
		rep.Totals = &report.Totals{
			InputTokens: result.Totals.Input, OutputTokens: result.Totals.Output,
			CachedTokens: result.Totals.Cached, ReasoningTokens: result.Totals.Reasoning,
			CacheCreationTokens:  result.Totals.CacheCreation,
			CacheCreationPresent: result.Totals.HasCacheCreation}
	}
	rep.MetricsUnavailable = status == "completed" && len(result.Calls) == 0 && provider != "codex"
	rep.BillingMode = result.BillingMode
	rep.ReasoningEffort = result.ReasoningEffort
	switch {
	case result.NeedsApproval != nil && *result.NeedsApproval != "":
		msg := "waiting for approval: " + *result.NeedsApproval
		rep.Error = &msg
	case result.ErrorOverride != nil && *result.ErrorOverride != "":
		rep.Error = result.ErrorOverride
	case status != "completed" && stderrTail != "":
		rep.Error = &stderrTail
	}
	r.applyCost(&rep, result, provider, opts.Pricing)
	if err := r.WriteRun(runDir, rep); err != nil {
		return rep, err
	}
	printMu.Lock()
	r.PrintSummary(rep, result, runDir)
	printMu.Unlock()
	return rep, nil
}

func strOrNilVal(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func intOrNil(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func intPtrFrom(p *int64) *int {
	if p == nil {
		return nil
	}
	v := int(*p)
	return &v
}

func (r *Runner) applyCost(rep *report.Report, result Result, provider string, userRates map[string]Rates) {
	rates := userRates
	if rates == nil {
		parsed, err := EnvPricing()
		if err == nil {
			rates = parsed
		}
	}
	reported := rep.CostUSD
	paid := isPaid(provider)
	_, modelListed := pricing.ListPrices[strVal(rep.Model)]
	listOK := paid && modelListed
	_, hasOwn := PricingFor(strVal(rep.Model), rates)
	preferOwn := reported != nil && strings.HasPrefix(strVal(rep.Model), "muse-") && hasOwn
	reportedSource := "reported"
	if reported != nil && !preferOwn && !listOK {
		rep.CostSource = &reportedSource
		return
	}
	var computed *ComputedCost
	if paid {
		var callTokens []pricing.Tokens
		for _, c := range result.Calls {
			callTokens = append(callTokens, pricing.Tokens{
				Input: c.InputTokens, Cached: c.CachedTokens, Output: c.OutputTokens})
		}
		var totalsCacheCreation *int64
		hasCacheCreation := false
		if result.Totals != nil {
			totalsCacheCreation = result.Totals.CacheCreation
			hasCacheCreation = result.Totals.HasCacheCreation
		}
		computed = ComputeCost(strVal(rep.Model), result.Totals.pricingTokens(),
			totalsCacheCreation, hasCacheCreation, callTokens, rates)
	}
	if computed != nil {
		rep.CostUSD = &computed.CostUSD
		source := "computed"
		rep.CostSource = &source
		rep.Pricing = pricingUsedFromMap(computed.Used)
		return
	}
	if listOK {
		totalsArg := result.Totals.pricingTokens()
		var callTokens []pricing.Tokens
		if totalsArg == nil {
			for _, c := range result.Calls {
				callTokens = append(callTokens, pricing.Tokens{
					Input: c.InputTokens, Cached: c.CachedTokens, Output: c.OutputTokens})
			}
		}
		// Python passes the totals dict even when falsy values
		// are present. An empty dict would fall through to
		// calls there. Recorded totals always carry keys here.
		listed, used := pricing.ListCost(strVal(rep.Model), totalsArg, callTokens)
		if listed != nil && used != nil {
			rep.CostUSD = listed
			source := "list"
			rep.CostSource = &source
			rep.Pricing = &report.Pricing{
				InputPerMTok: used.InputPerMTok, CachedPerMTok: used.CachedPerMTok,
				OutputPerMTok: used.OutputPerMTok, Model: used.Model,
				Source: used.Source, Fetched: used.Fetched}
			return
		}
	}
	if reported != nil {
		rep.CostSource = &reportedSource
	}
}

func pricingUsedFromMap(used map[string]any) *report.Pricing {
	get := func(k string) float64 {
		if f, ok := used[k].(float64); ok {
			return f
		}
		return 0
	}
	p := &report.Pricing{
		InputPerMTok: get("input_per_mtok"), OutputPerMTok: get("output_per_mtok"),
		CachedPerMTok: get("cached_per_mtok")}
	if _, ok := used["cache_creation_per_mtok"]; ok {
		v := get("cache_creation_per_mtok")
		p.CacheCreationPerMTok = &v
	}
	if m, ok := used["model"].(string); ok {
		p.Model = m
	}
	if s, ok := used["source"].(string); ok {
		p.Source = s
	}
	if s, ok := used["fetched"].(string); ok {
		p.Fetched = s
	}
	return p
}
