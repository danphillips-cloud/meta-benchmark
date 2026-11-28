package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"meta-benchmark/internal/pricing"
)

// SuiteEntry is one normalised suite prompt.
type SuiteEntry struct {
	Name           string
	Prompt         string
	Provider       string
	Model          *string
	Minimal        bool
	Skip           bool
	TimeoutSeconds *int
	Checks         *Checks
}

// SuiteSettings is a manifest settings block.
type SuiteSettings struct {
	Concurrency       int
	TimeoutSeconds    *int
	Repeat            *int
	MaxCostUSD        *float64
	MaxRuntimeSeconds *float64
	Pricing           map[string]Rates
}

// Manifest is a suite file plus settings.
type Manifest struct {
	Settings SuiteSettings
	Entries  []SuiteEntry
}

// SuiteDefaultName is the default suite file name.
const SuiteDefaultName = "golden-prompts.json"

func readSuiteData(path string) (any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("cannot read suite file %s: No such file or directory", path)
		}
		return nil, fmt.Errorf("cannot read suite file %s: %v", path, err)
	}
	if !isValidUTF8(data) {
		return nil, fmt.Errorf("suite file %s is not valid UTF-8 text", path)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, fmt.Errorf("suite file %s is not valid JSON", path)
	}
	return value, nil
}

func isValidUTF8(b []byte) bool { return utf8.Valid(b) }

// ParseChecks validates a checks value like run-muse
// parse_checks. A nil value gives nil checks.
func ParseChecks(value any) (*Checks, error) {
	if value == nil {
		return nil, nil
	}
	m, ok := value.(map[string]any)
	if !ok || len(m) == 0 {
		return nil, fmt.Errorf("checks needs reply_contains or files_exist lists")
	}
	for key := range m {
		if key != "reply_contains" && key != "files_exist" {
			return nil, fmt.Errorf("checks needs reply_contains or files_exist lists")
		}
	}
	checks := &Checks{}
	for key, raw := range m {
		list, ok := raw.([]any)
		if !ok || len(list) == 0 {
			return nil, fmt.Errorf("checks needs non-empty lists of non-empty strings")
		}
		items := make([]string, 0, len(list))
		for _, item := range list {
			s, ok := item.(string)
			if !ok || s == "" {
				return nil, fmt.Errorf("checks needs non-empty lists of non-empty strings")
			}
			items = append(items, s)
		}
		if key == "files_exist" {
			for _, p := range items {
				if filepath.IsAbs(p) || hasDotDot(p) {
					return nil, fmt.Errorf("files_exist paths must stay inside the workspace")
				}
			}
			checks.FilesExist = items
		} else {
			checks.ReplyContains = items
		}
	}
	return checks, nil
}

func hasDotDot(p string) bool {
	for _, part := range strings.Split(filepath.ToSlash(p), "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

func exactInt(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	case float64:
		if n == float64(int64(n)) {
			return int64(n), true
		}
	}
	return 0, false
}

func suiteEntries(data any, path string) ([]SuiteEntry, error) {
	root, _ := data.(map[string]any)
	raw, _ := root["prompts"].([]any)
	if len(raw) == 0 {
		return nil, fmt.Errorf("suite file needs a non-empty 'prompts' list")
	}
	entries := make([]SuiteEntry, 0, len(raw))
	seen := map[string]bool{}
	for i, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("suite entry %d needs non-empty 'name' and 'prompt'", i+1)
		}
		name, _ := entry["name"].(string)
		promptRaw, hasPrompt := entry["prompt"]
		fileRaw, hasFile := entry["file"]
		if strings.TrimSpace(name) == "" {
			return nil, fmt.Errorf("suite entry %d needs non-empty 'name' and 'prompt'", i+1)
		}
		if hasPrompt && promptRaw != nil && hasFile && fileRaw != nil {
			return nil, fmt.Errorf("suite entry '%s' has both 'prompt' and 'file'. Give one only", name)
		}
		var prompt string
		if hasFile && fileRaw != nil {
			promptFile, isStr := fileRaw.(string)
			if !isStr || strings.TrimSpace(promptFile) == "" {
				return nil, fmt.Errorf("suite entry '%s' needs a non-empty 'file'", name)
			}
			filePath := promptFile
			if !filepath.IsAbs(filePath) {
				filePath = filepath.Join(filepath.Dir(path), filePath)
			}
			content, err := os.ReadFile(filePath)
			if err != nil {
				return nil, fmt.Errorf("cannot read prompt file %s for suite entry '%s': %v", filePath, name, err)
			}
			if !isValidUTF8(content) {
				return nil, fmt.Errorf("prompt file %s for suite entry '%s' is not valid UTF-8 text", filePath, name)
			}
			prompt = string(content)
		} else if p, isStr := promptRaw.(string); isStr {
			prompt = p
		}
		if strings.TrimSpace(prompt) == "" {
			return nil, fmt.Errorf("suite entry %d needs non-empty 'name' and 'prompt'", i+1)
		}
		skip := false
		if rawSkip, present := entry["skip"]; present && rawSkip != nil {
			b, isBool := rawSkip.(bool)
			if !isBool {
				return nil, fmt.Errorf("suite entry '%s' needs 'skip' to be true or false", name)
			}
			skip = b
		}
		var entryTimeout *int
		if rawTimeout, present := entry["timeout_seconds"]; present && rawTimeout != nil {
			v, isInt := exactInt(rawTimeout)
			if _, isBool := rawTimeout.(bool); isBool || !isInt || v < 1 {
				return nil, fmt.Errorf("suite entry '%s' needs 'timeout_seconds' to be a whole number of seconds, at least 1", name)
			}
			iv := int(v)
			entryTimeout = &iv
		}
		if seen[name] {
			return nil, fmt.Errorf("duplicate suite prompt name '%s'", name)
		}
		seen[name] = true
		checks, err := ParseChecks(entry["checks"])
		if err != nil {
			return nil, fmt.Errorf("suite entry '%s': %v", name, err)
		}
		provider := DefaultProvider()
		if p, isStr := entry["provider"].(string); isStr && p != "" {
			provider = p
		}
		var model *string
		if rawModel, present := entry["model"]; present && rawModel != nil {
			text := fmt.Sprint(rawModel)
			if s, isStr := rawModel.(string); isStr {
				text = s
			}
			model = &text
		}
		minimal := false
		if rawMinimal, present := entry["minimal"]; present {
			minimal = truthyValue(rawMinimal)
		}
		entries = append(entries, SuiteEntry{
			Name: name, Prompt: prompt, Provider: provider, Model: model,
			Minimal: minimal, Skip: skip, TimeoutSeconds: entryTimeout,
			Checks: checks})
	}
	return entries, nil
}

func truthyValue(v any) bool {
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
	case json.Number:
		f, _ := n.Float64()
		return f != 0
	case float64:
		return n != 0
	}
	return true
}

// LoadSuite reads a golden prompts file.
func LoadSuite(path string) ([]SuiteEntry, error) {
	data, err := readSuiteData(path)
	if err != nil {
		return nil, err
	}
	return suiteEntries(data, path)
}

func positiveNumber(value any, key string, whole bool) (*float64, error) {
	if value == nil {
		return nil, nil
	}
	if _, isBool := value.(bool); isBool {
		return nil, fmt.Errorf("suite settings need '%s' to be a positive number", key)
	}
	if whole {
		v, ok := exactInt(value)
		if !ok || v < 1 {
			return nil, fmt.Errorf("suite settings need '%s' to be a positive number", key)
		}
		f := float64(v)
		return &f, nil
	}
	f, ok := numberValue(value)
	if !ok || f <= 0 {
		return nil, fmt.Errorf("suite settings need '%s' to be a positive number", key)
	}
	return &f, nil
}

func numberValue(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case float64:
		return n, true
	}
	return 0, false
}

// LoadManifest reads a suite file plus its settings block.
func LoadManifest(path string) (*Manifest, error) {
	data, err := readSuiteData(path)
	if err != nil {
		return nil, err
	}
	entries, err := suiteEntries(data, path)
	if err != nil {
		return nil, err
	}
	root, _ := data.(map[string]any)
	rawSettings := map[string]any{}
	if root != nil && root["settings"] != nil {
		settingsMap, ok := root["settings"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("suite 'settings' must be an object")
		}
		rawSettings = settingsMap
	}
	concurrency := int64(1)
	if raw, present := rawSettings["concurrency"]; present {
		v, ok := exactInt(raw)
		if _, isBool := raw.(bool); isBool || !ok || v < 1 || v > 8 {
			return nil, fmt.Errorf("suite settings need 'concurrency' to be a whole number from 1 to 8")
		}
		concurrency = v
	}
	var settingsTimeout *int
	if raw, present := rawSettings["timeout_seconds"]; present && raw != nil {
		v, ok := exactInt(raw)
		if _, isBool := raw.(bool); isBool || !ok || v < 1 {
			return nil, fmt.Errorf("suite settings need 'timeout_seconds' to be a whole number of seconds, at least 1")
		}
		iv := int(v)
		settingsTimeout = &iv
	}
	repeatF, err := positiveNumber(rawSettings["repeat"], "repeat", true)
	if err != nil {
		return nil, err
	}
	maxCost, err := positiveNumber(rawSettings["max_cost_usd"], "max_cost_usd", false)
	if err != nil {
		return nil, err
	}
	maxRuntime, err := positiveNumber(rawSettings["max_runtime_seconds"], "max_runtime_seconds", false)
	if err != nil {
		return nil, err
	}
	settingsPricing, err := ParsePricing(rawSettings["pricing"], fmt.Sprintf("settings in %s", path))
	if err != nil {
		return nil, err
	}
	settings := SuiteSettings{
		Concurrency: int(concurrency), TimeoutSeconds: settingsTimeout,
		MaxCostUSD: maxCost, MaxRuntimeSeconds: maxRuntime, Pricing: settingsPricing}
	if repeatF != nil {
		iv := int(*repeatF)
		settings.Repeat = &iv
	}
	return &Manifest{Settings: settings, Entries: entries}, nil
}

// ApplySuiteModel fills entries that name no model for one provider.
func ApplySuiteModel(entries []SuiteEntry, provider, model string) {
	if model == "" {
		return
	}
	for i := range entries {
		if entries[i].Model == nil && entries[i].Provider == provider {
			m := model
			entries[i].Model = &m
		}
	}
}

// ValidateSuiteModels resolves every non-skip entry model.
func ValidateSuiteModels(entries []SuiteEntry) error {
	for _, entry := range entries {
		if entry.Skip {
			continue
		}
		model := ""
		if entry.Model != nil {
			model = *entry.Model
		}
		if _, err := ResolveModel(entry.Provider, model); err != nil {
			return err
		}
	}
	return nil
}

// EffectiveTimeout applies flag, entry, settings, default order.
func EffectiveTimeout(entry SuiteEntry, settings SuiteSettings, cliTimeout *int) int {
	if cliTimeout != nil {
		return *cliTimeout
	}
	if entry.TimeoutSeconds != nil {
		return *entry.TimeoutSeconds
	}
	if settings.TimeoutSeconds != nil {
		return *settings.TimeoutSeconds
	}
	return DefaultTimeout(entry.Provider)
}

// PreviousSuiteVersion finds the last suite harness version
// recorded for a provider in the index.
func (r *Runner) PreviousSuiteVersion(provider string) *string {
	var last *string
	for _, entry := range r.indexEntries() {
		if truthyValue(entry["suite_id"]) &&
			entryStr(entry, "provider") == provider {
			if v, ok := entry["harness_version"].(string); ok && v != "" {
				value := v
				last = &value
			}
		}
	}
	return last
}

func entryStr(entry map[string]any, key string) string {
	s, _ := entry[key].(string)
	return s
}

// SuiteVersionNotice renders the harness change line, if any.
func SuiteVersionNotice(previous, current *string, provider string) string {
	if previous != nil && current != nil && *previous != "" && *current != "" && *previous != *current {
		return fmt.Sprintf("Harness changed since the last suite run: %s was %s, now %s.",
			provider, *previous, *current)
	}
	return ""
}

// SuiteStatePath returns the resume state path beside a suite file.
func SuiteStatePath(path string) string {
	ext := filepath.Ext(path)
	return path[:len(path)-len(ext)] + ".state.json"
}

// SuiteState is the resume state stored beside a suite file.
// Records stay generic maps so state files written by either
// implementation keep working in the other.
type SuiteState struct {
	Manifest string                    `json:"manifest"`
	SuiteID  string                    `json:"suite_id"`
	Entries  map[string]map[string]any `json:"entries"`
}

// LoadState reads resume state, or returns nil when absent.
// A present but untrusted file is an error, never a silent
// rerun of finished entries.
func LoadState(path string) (*SuiteState, error) {
	statePath := SuiteStatePath(path)
	data, err := os.ReadFile(statePath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var state SuiteState
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&state); err != nil {
		return nil, fmt.Errorf("state file %s is not valid JSON. Fix it or delete it and start again", statePath)
	}
	if state.Manifest != filepath.Base(path) || state.SuiteID == "" || state.Entries == nil {
		return nil, fmt.Errorf("state file %s does not belong to %s. Delete it if it is stale",
			statePath, filepath.Base(path))
	}
	return &state, nil
}

// SaveState writes resume state atomically.
func SaveState(path string, state *SuiteState) error {
	statePath := SuiteStatePath(path)
	tmp := statePath + ".tmp"
	body, err := marshalIndentValue(state)
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, statePath)
}

func marshalIndentValue(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func entryModel(entry SuiteEntry) string {
	model := ""
	if entry.Model != nil {
		model = *entry.Model
	}
	if model == "" {
		def, _ := DefaultModel(entry.Provider)
		model = def
	}
	return recordedModel(entry.Provider, model)
}

func pricedText(entry SuiteEntry, rates map[string]Rates) string {
	provider, model := entry.Provider, entryModel(entry)
	switch {
	case provider == "codex":
		return "cost not recorded (subscription or API login)"
	case provider == "echo":
		return "bills nothing"
	case !isPaid(provider):
		return "plan usage"
	}
	if _, ok := PricingFor(model, rates); ok {
		return "priced at your rates"
	}
	if _, listed := pricing.ListPrices[model]; listed {
		return "priced at Meta list"
	}
	if provider == "claude-code" && !strings.HasPrefix(model, "muse-") {
		return "cost reported by Claude Code"
	}
	return "unpriced"
}

func checksToGeneric(checks *Checks) map[string]any {
	if checks == nil {
		return nil
	}
	out := map[string]any{}
	if len(checks.ReplyContains) > 0 {
		items := make([]any, len(checks.ReplyContains))
		for i, s := range checks.ReplyContains {
			items[i] = s
		}
		out["reply_contains"] = items
	}
	if len(checks.FilesExist) > 0 {
		items := make([]any, len(checks.FilesExist))
		for i, s := range checks.FilesExist {
			items[i] = s
		}
		out["files_exist"] = items
	}
	return out
}

// PreviousCheckStatus mirrors previous_check_status.
func PreviousCheckStatus(entry SuiteEntry, record map[string]any) string {
	if entry.Checks == nil {
		return "not_checked"
	}
	required := checksToGeneric(entry.Checks)
	var validation map[string]any
	if v, ok := record["task_validation"].(map[string]any); ok {
		validation = v
	}
	var recorded any
	if v, present := record["checks"]; present && v != nil {
		recorded = v
	} else {
		grouped := map[string]any{}
		if validation != nil {
			if list, ok := validation["checks"].([]any); ok {
				for _, item := range list {
					row, _ := item.(map[string]any)
					name, _ := row["check"].(string)
					existing, _ := grouped[name].([]any)
					grouped[name] = append(existing, row["value"])
				}
			}
		}
		recorded = grouped
	}
	recordedMap, isMap := recorded.(map[string]any)
	if isMap && len(recordedMap) == 0 && validation != nil && validation["status"] == "failed" {
		return "failed"
	}
	if reflect.DeepEqual(required, recorded) {
		if validation != nil {
			if s, ok := validation["status"].(string); ok {
				return s
			}
		}
		return "not_checked"
	}
	return "not_checked"
}

// ReusableResult reports whether a recorded result can be skipped.
func ReusableResult(entry SuiteEntry, record map[string]any) bool {
	if record == nil || record["status"] != "completed" {
		return false
	}
	return entry.Checks == nil || PreviousCheckStatus(entry, record) == "passed"
}

// PrintSuitePlan prints the --dry-run listing. It runs nothing.
func (r *Runner) PrintSuitePlan(path string, settings SuiteSettings,
	entries []SuiteEntry, rates map[string]Rates, cliTimeout *int,
	repeat int, resume, fresh bool) int {
	out := r.Out
	if out == nil {
		out = os.Stdout
	}
	if err := ValidateSuiteModels(entries); err != nil {
		fmt.Fprintln(out, err)
		return 1
	}
	fmt.Fprintf(out, "Suite file: %s\n", path)
	fmt.Fprintf(out, "%d prompt(s), %d repeat(s) each, concurrency %d\n",
		len(entries), repeat, settings.Concurrency)
	if settings.MaxCostUSD != nil {
		fmt.Fprintf(out, "Cost budget: stop starting new entries at $%.2f of recorded cost\n",
			*settings.MaxCostUSD)
	}
	if settings.MaxRuntimeSeconds != nil {
		fmt.Fprintf(out, "Runtime budget: stop starting new entries after %s seconds\n",
			pyNum(*settings.MaxRuntimeSeconds))
	}
	var state *SuiteState
	if resume && fresh {
		fmt.Fprintln(out, "Fresh: saved progress will be ignored. Every entry runs again under a new suite id")
	} else if resume {
		loaded, err := LoadState(path)
		if err != nil {
			fmt.Fprintf(out, "State problem: %v\n", err)
			return 1
		}
		state = loaded
		if state != nil {
			done := 0
			for n := 1; n <= repeat; n++ {
				for _, entry := range entries {
					if !entry.Skip && ReusableResult(entry, state.Entries[fmt.Sprintf("%s#%d", entry.Name, n)]) {
						done++
					}
				}
			}
			fmt.Fprintf(out, "Resume: suite %s, %d already completed\n", state.SuiteID, done)
		} else {
			fmt.Fprintln(out, "Resume: no state file yet. A fresh suite id will be recorded on the first real run")
		}
	}
	anyPaid, anyCodex, anyUnpriced := false, false, false
	for _, entry := range entries {
		paid := isPaid(entry.Provider)
		anyPaid = anyPaid || (paid && !entry.Skip)
		codex := entry.Provider == "codex"
		anyCodex = anyCodex || (codex && !entry.Skip)
		priced := pricedText(entry, rates)
		anyUnpriced = anyUnpriced || (!entry.Skip && (codex || priced == "unpriced"))
		model := entryModel(entry)
		if model == "" {
			model = "?"
		}
		parts := []string{entry.Name, entry.Provider + "/" + model,
			fmt.Sprintf("timeout %d s", EffectiveTimeout(entry, settings, cliTimeout)), priced}
		if codex {
			parts = append(parts, "MAY BE PAID")
		} else if paid {
			parts = append(parts, "PAID")
		}
		if entry.Skip {
			parts = append(parts, "skip")
		}
		fmt.Fprintln(out, "- "+strings.Join(parts, " · "))
	}
	if anyCodex && settings.Concurrency > 1 {
		fmt.Fprintln(out, "Entries can run at the same time at this concurrency. Codex may use subscription or API billing. API-key logins spend in parallel")
	} else if anyPaid && settings.Concurrency > 1 {
		fmt.Fprintln(out, "Paid entries can run at the same time at this concurrency. They spend in parallel")
	}
	if settings.MaxCostUSD != nil && anyUnpriced {
		fmt.Fprintln(out, "Some entries are unpriced. The cost budget counts priced and reported runs only. It cannot cap unrecorded charges")
	}
	fmt.Fprintln(out, "Dry run only. Nothing was run")
	return 0
}

func recordNum(record map[string]any, key string) *float64 {
	if record == nil {
		return nil
	}
	switch n := record[key].(type) {
	case json.Number:
		if f, err := n.Float64(); err == nil {
			return &f
		}
	case float64:
		return &n
	}
	return nil
}

func recordStrPtr(record map[string]any, key string) *string {
	if record == nil {
		return nil
	}
	if s, ok := record[key].(string); ok {
		return &s
	}
	return nil
}

// RunSuite runs a suite file and returns its exit code. It
// mirrors run-muse run_suite including budgets, resume state,
// and concurrency.
func (r *Runner) RunSuite(ctx context.Context, path string, cliTimeout *int,
	repeatOpt *int, dryRun, resume, fresh bool, manifest *Manifest) (int, error) {
	out := r.Out
	if out == nil {
		out = os.Stdout
	}
	if manifest == nil {
		loaded, err := LoadManifest(path)
		if err != nil {
			return 2, err
		}
		manifest = loaded
	}
	settings, entries := manifest.Settings, manifest.Entries
	if err := ValidateSuiteModels(entries); err != nil {
		return 2, err
	}
	rates, err := EnvPricing()
	if err != nil {
		return 2, err
	}
	for k, v := range settings.Pricing {
		rates[k] = v
	}
	repeat := 3
	if settings.Repeat != nil {
		repeat = *settings.Repeat
	}
	if repeatOpt != nil {
		repeat = *repeatOpt
	}
	if dryRun {
		return r.PrintSuitePlan(path, settings, entries, rates, cliTimeout, repeat, resume, fresh), nil
	}
	var state *SuiteState
	var suiteID string
	if resume {
		if !fresh {
			loaded, err := LoadState(path)
			if err != nil {
				return 2, err
			}
			state = loaded
		}
		if state == nil {
			state = &SuiteState{Manifest: filepath.Base(path),
				SuiteID: shortHex(8), Entries: map[string]map[string]any{}}
			if err := SaveState(path, state); err != nil {
				return 1, err
			}
		}
		suiteID = state.SuiteID
	} else {
		suiteID = shortHex(8)
	}
	fmt.Fprintf(out, "Suite %s: %d prompt(s), %d repeat(s) each\n", suiteID, len(entries), repeat)
	var providers []string
	for _, entry := range entries {
		seen := false
		for _, p := range providers {
			if p == entry.Provider {
				seen = true
			}
		}
		if !seen {
			providers = append(providers, entry.Provider)
		}
	}
	harnessFn := r.HarnessVersionFn
	if harnessFn == nil {
		harnessFn = HarnessVersion
	}
	for _, provider := range providers {
		if notice := SuiteVersionNotice(r.PreviousSuiteVersion(provider),
			harnessFn(provider), provider); notice != "" {
			fmt.Fprintln(out, notice)
		}
	}
	type workItem struct {
		key   string
		entry SuiteEntry
	}
	var work []workItem
	for roundNo := 1; roundNo <= repeat; roundNo++ {
		for _, entry := range entries {
			work = append(work, workItem{fmt.Sprintf("%s#%d", entry.Name, roundNo), entry})
		}
	}
	entryByKey := map[string]SuiteEntry{}
	for _, item := range work {
		entryByKey[item.key] = item.entry
	}
	doneBefore := map[string]bool{}
	taskResults := map[string]string{}
	spent := 0.0
	if state != nil {
		for key, record := range state.Entries {
			if entry, known := entryByKey[key]; known && !entry.Skip {
				if ReusableResult(entry, record) {
					doneBefore[key] = true
				}
				taskResults[key] = PreviousCheckStatus(entry, record)
			}
			recordModel := recordStrPtr(record, "model")
			modelName := ""
			if recordModel != nil {
				modelName = *recordModel
			} else if entry, known := entryByKey[key]; known {
				modelName = entryModel(entry)
			}
			if prior := recordNum(record, "prior_cost_usd"); prior != nil {
				spent += *prior
			}
			if counted := CountedCost(modelName, recordNum(record, "cost_usd"),
				recordStrPtr(record, "cost_source")); counted != nil {
				spent += *counted
			}
		}
		already := 0
		for _, item := range work {
			if doneBefore[item.key] {
				already++
			}
		}
		if already > 0 {
			fmt.Fprintf(out, "Resuming. %d already completed and will not run again\n", already)
		}
	}
	if settings.MaxCostUSD != nil {
		for _, e := range entries {
			if !e.Skip && (e.Provider == "codex" || pricedText(e, rates) == "unpriced") {
				fmt.Fprintln(out, "Warning: some entries are unpriced. The cost budget counts priced and reported runs only. It cannot cap unrecorded charges")
				break
			}
		}
	}
	var stateMu sync.Mutex
	budget := struct {
		spent  float64
		reason string
	}{spent: spent}
	started := time.Now()
	stopCtx, stopAll := context.WithCancel(ctx)
	defer stopAll()
	results := map[string]string{}
	var resultsMu sync.Mutex

	mark := func(key string, record map[string]any) {
		if state == nil {
			return
		}
		stateMu.Lock()
		defer stateMu.Unlock()
		old := state.Entries[key]
		prior := 0.0
		if p := recordNum(old, "prior_cost_usd"); p != nil {
			prior = *p
		}
		if record["status"] == "running" {
			modelName := ""
			if m := recordStrPtr(old, "model"); m != nil && *m != "" {
				modelName = *m
			} else if entry, known := entryByKey[key]; known {
				modelName = entryModel(entry)
			}
			if counted := CountedCost(modelName, recordNum(old, "cost_usd"),
				recordStrPtr(old, "cost_source")); counted != nil {
				prior += *counted
			}
		}
		record["prior_cost_usd"] = prior
		state.Entries[key] = record
		_ = SaveState(path, state)
	}

	attempt := func(key string, entry SuiteEntry) (string, error) {
		select {
		case <-stopCtx.Done():
			return "not_started", nil
		default:
		}
		var remaining *float64
		stateMu.Lock()
		if settings.MaxCostUSD != nil && budget.spent >= *settings.MaxCostUSD {
			budget.reason = "cost budget reached"
			stateMu.Unlock()
			return "not_started", nil
		}
		if settings.MaxRuntimeSeconds != nil {
			left := *settings.MaxRuntimeSeconds - time.Since(started).Seconds()
			remaining = &left
			if left < 1 {
				budget.reason = "runtime budget reached"
				stateMu.Unlock()
				return "not_started", nil
			}
		}
		stateMu.Unlock()
		entryTimeout := EffectiveTimeout(entry, settings, cliTimeout)
		if remaining != nil && int(*remaining) < entryTimeout {
			entryTimeout = int(*remaining)
		}
		mark(key, map[string]any{
			"status": "running", "run_id": nil, "cost_usd": nil,
			"wall_seconds": nil, "updated_at": isoTime(time.Now())})
		attemptCtx := ctx
		if settings.Concurrency > 1 {
			attemptCtx = stopCtx
		}
		rep, err := r.RunPrompt(attemptCtx, entry.Prompt, Options{
			Provider: entry.Provider, Model: strVal(entry.Model),
			Minimal: entry.Minimal, Timeout: &entryTimeout,
			SuiteID: &suiteID, SuitePrompt: &entry.Name,
			Pricing: rates, Checks: entry.Checks,
		})
		if err != nil {
			return "failed", err
		}
		status := reportStatus(rep.Status)
		stateMu.Lock()
		taskStatus := "not_checked"
		if rep.TaskValidation != nil {
			taskStatus = rep.TaskValidation.Status
		}
		taskResults[key] = taskStatus
		if counted := CountedCost(strVal(rep.Model), rep.CostUSD, rep.CostSource); counted != nil {
			budget.spent += *counted
		} else if rep.CostUSD == nil {
			if counted := CountedCost(entryModel(entry), nil, nil); counted != nil {
				budget.spent += *counted
			}
		}
		stateMu.Unlock()
		if status == "interrupted" {
			stopAll()
		}
		var wallSeconds *float64
		if rep.WallMS != nil {
			v := *rep.WallMS / 1000
			wallSeconds = &v
		}
		var validation any
		if rep.TaskValidation != nil {
			validation = rep.TaskValidation
		}
		mark(key, map[string]any{
			"status": status, "task_validation": validation,
			"checks": checksToGeneric(entry.Checks), "run_id": strOrNilVal(rep.RunID),
			"model": strOrNilVal(rep.Model), "cost_usd": floatOrNil(rep.CostUSD),
			"cost_source": strOrNilVal(rep.CostSource), "wall_seconds": floatOrNil(wallSeconds),
			"updated_at": isoTime(time.Now())})
		return status, nil
	}

	var pending []workItem
	for _, item := range work {
		switch {
		case item.entry.Skip:
			fmt.Fprintf(out, "Skipping %s (skip is true)\n", item.entry.Name)
			resultsMu.Lock()
			results[item.key] = "skipped"
			resultsMu.Unlock()
		case doneBefore[item.key]:
			resultsMu.Lock()
			results[item.key] = "completed"
			resultsMu.Unlock()
		default:
			pending = append(pending, item)
		}
	}
	interrupted := false
	var firstErr error
	if settings.Concurrency > 1 && len(pending) > 1 {
		jobs := make(chan workItem)
		var wg sync.WaitGroup
		workers := settings.Concurrency
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for item := range jobs {
					status, err := attempt(item.key, item.entry)
					resultsMu.Lock()
					if err != nil && firstErr == nil {
						firstErr = err
					}
					results[item.key] = status
					resultsMu.Unlock()
				}
			}()
		}
		for _, item := range pending {
			jobs <- item
		}
		close(jobs)
		wg.Wait()
		if ctx.Err() != nil {
			interrupted = true
		}
	} else {
		for _, item := range pending {
			if interrupted {
				results[item.key] = "not_started"
				continue
			}
			status, err := attempt(item.key, item.entry)
			if err != nil {
				return 1, err
			}
			if ctx.Err() != nil && status != "interrupted" {
				status = "interrupted"
				mark(item.key, map[string]any{
					"status": "interrupted", "run_id": nil, "cost_usd": nil,
					"wall_seconds": nil, "updated_at": isoTime(time.Now())})
			}
			results[item.key] = status
			if status == "interrupted" {
				interrupted = true
			}
		}
	}
	if firstErr != nil {
		return 1, firstErr
	}
	for _, status := range results {
		if status == "interrupted" {
			interrupted = true
		}
	}
	if state != nil {
		terminal := map[string]bool{
			"completed": true, "failed": true, "timeout": true,
			"needs_approval": true, "interrupted": true}
		for _, item := range pending {
			if results[item.key] != "not_started" {
				continue
			}
			stateMu.Lock()
			existing := ""
			if rec := state.Entries[item.key]; rec != nil {
				existing, _ = rec["status"].(string)
			}
			stateMu.Unlock()
			if terminal[existing] {
				continue
			}
			reason := budget.reason
			if reason == "" && interrupted {
				reason = "interrupted"
			}
			var reasonValue any
			if reason != "" {
				reasonValue = reason
			}
			mark(item.key, map[string]any{
				"status": "not_started", "run_id": nil, "cost_usd": nil,
				"wall_seconds": nil, "reason": reasonValue,
				"updated_at": isoTime(time.Now())})
		}
	}
	if budget.reason != "" {
		fmt.Fprintf(out, "Stopped starting new entries. %s. Recorded cost so far: $%.4f\n",
			budget.reason, budget.spent)
	}
	counts := map[string]int{}
	for _, status := range results {
		counts[status]++
	}
	closing := fmt.Sprintf("Suite %s done: %d completed of %d.", suiteID, counts["completed"], len(work))
	if r.UIEnabled {
		closing += fmt.Sprintf(" UI: %sradar", r.UIURL)
	}
	fmt.Fprintln(out, closing)
	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
	}
	sort.Strings(names)
	var countParts []string
	for _, name := range names {
		countParts = append(countParts, fmt.Sprintf("%s %d", name, counts[name]))
	}
	fmt.Fprintf(out, "Counts: %s. Recorded cost: $%.4f\n",
		strings.Join(countParts, ", "), budget.spent)
	var checkParts []string
	for _, name := range []string{"passed", "failed", "not_checked"} {
		n := 0
		for _, v := range taskResults {
			if v == name {
				n++
			}
		}
		checkParts = append(checkParts, fmt.Sprintf("%s %d", strings.ReplaceAll(name, "_", " "), n))
	}
	fmt.Fprintf(out, "Task checks: %s\n", strings.Join(checkParts, ", "))
	if interrupted {
		return 130, nil
	}
	for _, v := range taskResults {
		if v == "failed" {
			return 1, nil
		}
	}
	for _, status := range results {
		if status != "completed" && status != "skipped" {
			return 1, nil
		}
	}
	return 0, nil
}

func floatOrNil(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}
