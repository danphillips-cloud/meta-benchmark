// Package pricing ports lib/pricing.py: published list pricing
// and subscription allowance maths. Nothing here estimates. Any
// missing recorded count gives nil, and the caller shows a dash.
package pricing

import "encoding/json"

const (
	ListSource  = "https://dev.meta.ai/docs/pricing-rate-limits"
	ListFetched = "2026-10-31"
)

// Rates are USD per million tokens.
type Rates struct {
	InputPerMTok  float64
	CachedPerMTok float64
	OutputPerMTok float64
}

// ListPrices is the Meta Model API published list, standard mode,
// as fetched on ListFetched. One model only. muse-wonder-full-1.0
// has no public per-token price and is deliberately absent.
var ListPrices = map[string]Rates{
	"muse-wonder-1.0": {InputPerMTok: 4.00, CachedPerMTok: 0.20, OutputPerMTok: 20.00},
}

// Used is the pricing record stored on a run.
type Used struct {
	InputPerMTok  float64 `json:"input_per_mtok"`
	CachedPerMTok float64 `json:"cached_per_mtok"`
	OutputPerMTok float64 `json:"output_per_mtok"`
	Model         string  `json:"model"`
	Source        string  `json:"source"`
	Fetched       string  `json:"fetched"`
}

// Tokens is one set of token counts. A nil field was not recorded.
type Tokens struct {
	Input  *int64
	Cached *int64
	Output *int64
}

// ListCost returns (cost, pricing used) at Meta's list, or
// (nil, nil). Token semantics differ per path. Totals record
// input including cached tokens, so the fresh part is input
// minus cached. Calls record input and cached as separate
// additive counts. Strict: any needed count missing gives nil.
func ListCost(model string, totals *Tokens, calls []Tokens) (*float64, *Used) {
	rates, ok := ListPrices[model]
	if !ok {
		return nil, nil
	}
	var cost float64
	if totals != nil {
		if totals.Input == nil || totals.Cached == nil || totals.Output == nil {
			return nil, nil
		}
		fresh := *totals.Input - *totals.Cached
		if fresh < 0 {
			return nil, nil
		}
		cost = (float64(fresh)*rates.InputPerMTok +
			float64(*totals.Cached)*rates.CachedPerMTok +
			float64(*totals.Output)*rates.OutputPerMTok) / 1000000
	} else if len(calls) > 0 {
		summed := func(get func(Tokens) *int64) (int64, bool) {
			var sum int64
			for _, c := range calls {
				v := get(c)
				if v == nil {
					return 0, false
				}
				sum += *v
			}
			return sum, true
		}
		inTok, okIn := summed(func(c Tokens) *int64 { return c.Input })
		cached, okCached := summed(func(c Tokens) *int64 { return c.Cached })
		outTok, okOut := summed(func(c Tokens) *int64 { return c.Output })
		if !okIn || !okCached || !okOut {
			return nil, nil
		}
		cost = (float64(inTok)*rates.InputPerMTok +
			float64(cached)*rates.CachedPerMTok +
			float64(outTok)*rates.OutputPerMTok) / 1000000
	} else {
		return nil, nil
	}
	used := &Used{
		InputPerMTok: rates.InputPerMTok, CachedPerMTok: rates.CachedPerMTok,
		OutputPerMTok: rates.OutputPerMTok, Model: model,
		Source: ListSource, Fetched: ListFetched,
	}
	return &cost, used
}

// Window is one allowance bucket.
type Window struct {
	UsedPercent *float64 `json:"used_percent"`
	ResetsAtMS  *int64   `json:"resets_at_ms"`
}

// Allowance is one normalised snapshot. A nil bucket was missing
// or malformed. The other bucket is kept.
type Allowance struct {
	Window *Window `json:"window"`
	Weekly *Window `json:"weekly"`
}

// Delta is percent movement per bucket. A nil bucket is unknown.
type Delta struct {
	Window *float64 `json:"window"`
	Weekly *float64 `json:"weekly"`
}

func asFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	// bool and every other type land here, like Python's check.
	return 0, false
}

func bucket(allowance map[string]any, name string) *Window {
	raw, ok := allowance[name].(map[string]any)
	if !ok {
		return nil
	}
	// Snake case wins when present, even as null, matching
	// dict.get(key, fallback) in Python.
	percentRaw, present := raw["used_percent"]
	if !present {
		percentRaw = raw["usedPercent"]
	}
	resetsRaw, present := raw["resets_at_ms"]
	if !present {
		resetsRaw = raw["resetsAtMs"]
	}
	percent, okPercent := asFloat(percentRaw)
	resets, okResets := asFloat(resetsRaw)
	if !okPercent || !okResets {
		return nil
	}
	resetsMS := int64(resets)
	return &Window{UsedPercent: &percent, ResetsAtMS: &resetsMS}
}

// Snapshot normalises one allowance reading, or returns nil.
// Accepts a muse usage JSON object (allowance nested, camelCase
// fields) or a raw stream allowance object (snake_case), decoded
// as generic JSON. Only when both limits are unusable is there
// no snapshot at all.
func Snapshot(obj any) *Allowance {
	m, ok := obj.(map[string]any)
	if !ok {
		return nil
	}
	allowance := m
	if nested, present := m["allowance"]; present {
		nm, ok := nested.(map[string]any)
		if !ok {
			return nil
		}
		allowance = nm
	}
	window := bucket(allowance, "window")
	weekly := bucket(allowance, "weekly")
	if window == nil && weekly == nil {
		return nil
	}
	return &Allowance{Window: window, Weekly: weekly}
}

// AllowanceDelta returns movement between two snapshots, per
// bucket. A bucket stays nil when a snapshot is missing, when
// the bucket reset in between, or when the percent went down.
func AllowanceDelta(start, end *Allowance) Delta {
	delta := Delta{}
	if start == nil || end == nil {
		return delta
	}
	delta.Window = bucketDelta(start.Window, end.Window)
	delta.Weekly = bucketDelta(start.Weekly, end.Weekly)
	return delta
}

func bucketDelta(before, after *Window) *float64 {
	if before == nil || after == nil {
		return nil
	}
	if before.ResetsAtMS == nil || after.ResetsAtMS == nil ||
		*before.ResetsAtMS != *after.ResetsAtMS {
		return nil
	}
	if before.UsedPercent == nil || after.UsedPercent == nil {
		return nil
	}
	moved := *after.UsedPercent - *before.UsedPercent
	if moved < 0 {
		return nil
	}
	return &moved
}
