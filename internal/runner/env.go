package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"meta-benchmark/internal/pricing"
)

// LoadDotenv loads KEY=VALUE lines into the environment.
// Blank lines and comments are skipped, surrounding quotes are
// stripped, and a variable already set wins. Values are never
// printed. A missing file is a no-op.
func LoadDotenv(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		key, value, _ := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 && value[0] == value[len(value)-1] &&
			(value[0] == '"' || value[0] == '\'') {
			value = value[1 : len(value)-1]
		}
		if key != "" {
			if _, present := os.LookupEnv(key); !present {
				_ = os.Setenv(key, value)
			}
		}
	}
}

// LoadDefaultDotenv looks for .env in the working directory,
// then beside the data directory. Tests use LoadDotenv with a
// fixture path and never touch a real .env.
func LoadDefaultDotenv(dataDir string) {
	if _, err := os.Stat(".env"); err == nil {
		LoadDotenv(".env")
		return
	}
	if dataDir != "" {
		LoadDotenv(filepath.Join(filepath.Dir(dataDir), ".env"))
	}
}

// ResolveDataDir returns the muse-runs directory.
// META_BENCHMARK_HOME, when set, is the parent that holds it.
func ResolveDataDir() string {
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

var stripEnv = []string{
	"META_API_KEY", "MUSE_API_TOKEN", "MODEL_API_KEY", "ANTHROPIC_API_KEY",
	"OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
}

// CleanEnv returns the environment without API keys, for child
// processes that must never receive one.
func CleanEnv() []string {
	strip := map[string]bool{}
	for _, k := range stripEnv {
		strip[k] = true
	}
	out := []string{}
	for _, kv := range os.Environ() {
		key, _, _ := strings.Cut(kv, "=")
		if !strip[key] {
			out = append(out, kv)
		}
	}
	return out
}

func envOr(key, fallback string) string {
	if v, present := os.LookupEnv(key); present {
		return v
	}
	return fallback
}

// DefaultProvider reads MUSE_PROVIDER at call time.
func DefaultProvider() string { return envOr("MUSE_PROVIDER", "meta") }

// DefaultModel returns the default model per provider. The
// second result is false for Codex with nothing configured.
// ANTHROPIC_MODEL is never consulted.
func DefaultModel(provider string) (string, bool) {
	switch provider {
	case "codex":
		model := os.Getenv("BENCH_CODEX_MODEL")
		return model, model != ""
	case "anthropic", "claude-code":
		if v, present := os.LookupEnv("BENCH_CLAUDE_MODEL"); present {
			return v, true
		}
		return "claude-sonnet-5-5", true
	default:
		return envOr("MUSE_MODEL", "muse-wonder-full-1.0"), true
	}
}

// ResolveModel applies defaults and rejects an unspecified
// Codex model before any work happens.
func ResolveModel(provider, model string) (string, error) {
	if model == "" {
		def, _ := DefaultModel(provider)
		model = def
	}
	if provider == "codex" {
		if strings.TrimSpace(model) == "" {
			//lint:ignore ST1005 the capital matches run-muse exactly
			return "", fmt.Errorf("Codex requires --model or BENCH_CODEX_MODEL")
		}
		return strings.TrimSpace(model), nil
	}
	return model, nil
}

// IsMuse reports whether a provider runs through Muse.
func IsMuse(provider string) bool {
	return provider != "anthropic" && provider != "claude-code" && provider != "codex"
}

func recordedModel(provider, model string) string {
	if provider == "echo" {
		return "echo"
	}
	return model
}

// PaidProviders bill an API key on every run.
var PaidProviders = []string{"claude-code", "anthropic"}

func isPaid(provider string) bool {
	return provider == "claude-code" || provider == "anthropic"
}

// DefaultTimeout mirrors run-muse: 300s for paid and Codex,
// 1800s otherwise.
func DefaultTimeout(provider string) int {
	if isPaid(provider) || provider == "codex" {
		return 300
	}
	return 1800
}

func endpointKeyName(model string) string {
	if strings.HasPrefix(model, "muse-") {
		return "MODEL_API_KEY"
	}
	return "ANTHROPIC_API_KEY"
}

// PaidNotice names the key a paid run will use.
func PaidNotice(model string) string {
	return "Paid run: uses " + endpointKeyName(model)
}

var harnessCache sync.Map // provider -> *string

// HarnessVersion reads the harness version once per process.
// Raw API and echo runs store nil. A failed command also
// stores nil instead of failing the run.
func HarnessVersion(provider string) *string {
	if provider == "anthropic" || provider == "echo" {
		return nil
	}
	if cached, ok := harnessCache.Load(provider); ok {
		return cached.(*string)
	}
	binary := "muse"
	switch provider {
	case "claude-code":
		binary = "claude"
	case "codex":
		binary = "codex"
	}
	var version *string
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, binary, "--version").Output(); err == nil {
		if text := strings.TrimSpace(string(out)); text != "" {
			if first := strings.TrimSpace(strings.Split(text, "\n")[0]); first != "" {
				version = &first
			}
		}
	}
	harnessCache.Store(provider, version)
	return version
}

// --- user supplied pricing (BENCH_PRICING) ---

// Rates is one user supplied pricing pair.
type Rates struct {
	InputPerMTok         *float64
	OutputPerMTok        *float64
	CachedPerMTok        *float64
	CacheCreationPerMTok *float64
}

func pricingPair(value any, where string) (Rates, error) {
	m, ok := value.(map[string]any)
	if !ok {
		return Rates{}, fmt.Errorf("pricing in %s needs input_per_mtok and output_per_mtok", where)
	}
	var pair Rates
	fields := []struct {
		key string
		dst **float64
	}{
		{"input_per_mtok", &pair.InputPerMTok},
		{"output_per_mtok", &pair.OutputPerMTok},
		{"cached_per_mtok", &pair.CachedPerMTok},
		{"cache_creation_per_mtok", &pair.CacheCreationPerMTok},
	}
	for _, f := range fields {
		raw, present := m[f.key]
		if (f.key == "cached_per_mtok" || f.key == "cache_creation_per_mtok") && !present {
			continue
		}
		rate, isNum := raw.(float64)
		if _, isBool := raw.(bool); isBool || !present || !isNum || rate < 0 {
			return Rates{}, fmt.Errorf(
				"pricing in %s needs a number at or above zero for '%s'", where, f.key)
		}
		v := rate
		*f.dst = &v
	}
	return pair, nil
}

// ParsePricing parses user supplied rates as {model: pair},
// "*" for any model. It accepts a decoded value or a JSON
// string. Nothing set gives an empty map.
func ParsePricing(raw any, where string) (map[string]Rates, error) {
	if where == "" {
		where = "BENCH_PRICING"
	}
	if raw == nil || raw == "" {
		return map[string]Rates{}, nil
	}
	if text, isStr := raw.(string); isStr {
		var decoded any
		if err := json.Unmarshal([]byte(text), &decoded); err != nil {
			return nil, fmt.Errorf("pricing in %s is not valid JSON", where)
		}
		raw = decoded
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("pricing in %s must be an object", where)
	}
	if _, hasIn := m["input_per_mtok"]; hasIn {
		pair, err := pricingPair(m, where)
		if err != nil {
			return nil, err
		}
		return map[string]Rates{"*": pair}, nil
	}
	if _, hasOut := m["output_per_mtok"]; hasOut {
		pair, err := pricingPair(m, where)
		if err != nil {
			return nil, err
		}
		return map[string]Rates{"*": pair}, nil
	}
	out := map[string]Rates{}
	for model, value := range m {
		if model == "" {
			return nil, fmt.Errorf("pricing in %s has a bad model key", where)
		}
		pair, err := pricingPair(value, where)
		if err != nil {
			return nil, err
		}
		out[model] = pair
	}
	return out, nil
}

// EnvPricing parses BENCH_PRICING.
func EnvPricing() (map[string]Rates, error) {
	return ParsePricing(os.Getenv("BENCH_PRICING"), "BENCH_PRICING")
}

// PricingFor picks the pair for a model, "*" as fallback.
func PricingFor(model string, rates map[string]Rates) (Rates, bool) {
	if len(rates) == 0 {
		return Rates{}, false
	}
	if pair, ok := rates[model]; ok {
		return pair, true
	}
	pair, ok := rates["*"]
	return pair, ok
}

// ComputedCost is a cost at the user's own rates plus the
// rates used, in report pricing shape.
type ComputedCost struct {
	CostUSD float64
	Used    map[string]any
}

// ComputeCost prices recorded tokens at user rates, or returns
// nil. It mirrors run-muse compute_cost.
func ComputeCost(model string, totals *pricing.Tokens, totalsCacheCreation *int64, hasCacheCreation bool, calls []pricing.Tokens, rates map[string]Rates) *ComputedCost {
	pair, ok := PricingFor(model, rates)
	if !ok || pair.InputPerMTok == nil || pair.OutputPerMTok == nil {
		return nil
	}
	var inTok, outTok *int64
	if totals != nil {
		inTok, outTok = totals.Input, totals.Output
	} else if len(calls) > 0 {
		summed := func(get func(pricing.Tokens) *int64) *int64 {
			var sum int64
			for _, c := range calls {
				v := get(c)
				if v == nil {
					return nil
				}
				sum += *v
			}
			return &sum
		}
		inTok = summed(func(c pricing.Tokens) *int64 { return c.Input })
		outTok = summed(func(c pricing.Tokens) *int64 { return c.Output })
	} else {
		return nil
	}
	if inTok == nil || outTok == nil {
		return nil
	}
	in := *inTok
	cacheCharge := 0.0
	if totals != nil && hasCacheCreation {
		components := []struct {
			count *int64
			rate  *float64
		}{{totals.Cached, pair.CachedPerMTok}, {totalsCacheCreation, pair.CacheCreationPerMTok}}
		for _, comp := range components {
			if comp.count == nil {
				if comp.rate == nil {
					return nil
				}
				continue
			}
			if *comp.count != 0 && comp.rate == nil {
				return nil
			}
			if *comp.count != 0 {
				in -= *comp.count
				cacheCharge += float64(*comp.count) * *comp.rate
			}
		}
	}
	if in < 0 {
		return nil
	}
	charge := float64(in)**pair.InputPerMTok + float64(*outTok)**pair.OutputPerMTok + cacheCharge
	used := map[string]any{"model": model,
		"input_per_mtok": *pair.InputPerMTok, "output_per_mtok": *pair.OutputPerMTok}
	if pair.CachedPerMTok != nil {
		used["cached_per_mtok"] = *pair.CachedPerMTok
	}
	if pair.CacheCreationPerMTok != nil {
		used["cache_creation_per_mtok"] = *pair.CacheCreationPerMTok
	}
	cost := charge / 1000000
	return &ComputedCost{CostUSD: cost, Used: used}
}

// CountedCost applies the display rule shared by terminal,
// budgets, and page. A reported muse-* figure never counts.
func CountedCost(model string, costUSD *float64, costSource *string) *float64 {
	if costUSD == nil {
		return nil
	}
	source := ""
	if costSource != nil {
		source = *costSource
	}
	if strings.HasPrefix(model, "muse-") && source != "computed" && source != "list" {
		return nil
	}
	return costUSD
}

// CaptureAllowanceStart snapshots allowance from
// `muse usage --json`, or returns nil. Any failure gives nil
// and the run carries on with a dash. The exec function is
// injectable so tests never execute anything.
func CaptureAllowanceStart(execFn func() ([]byte, error)) *pricing.Allowance {
	if execFn == nil {
		execFn = func() ([]byte, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "muse", "usage", "--json")
			cmd.Env = CleanEnv()
			return cmd.Output()
		}
	}
	out, err := execFn()
	if err != nil {
		return nil
	}
	var obj any
	if err := json.Unmarshal(out, &obj); err != nil {
		return nil
	}
	return pricing.Snapshot(obj)
}
