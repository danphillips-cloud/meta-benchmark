package pricing

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// These cases mirror PricingTest in tests/test_tool.py. The
// Python tests are the spec.

func i64(v int64) *int64 { return &v }

func loadUsage(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "fixtures", "muse-usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		t.Fatal(err)
	}
	return obj
}

func almost(t *testing.T, got *float64, want float64) {
	t.Helper()
	if got == nil || math.Abs(*got-want) > 1e-9 {
		t.Fatalf("cost = %v, want %v", got, want)
	}
}

func TestListCostTotalsSplitFreshAndCached(t *testing.T) {
	// Fresh 700k at $4, cached 300k at $0.20, out 100k at $20.
	cost, used := ListCost("muse-wonder-1.0",
		&Tokens{Input: i64(1000000), Cached: i64(300000), Output: i64(100000)}, nil)
	almost(t, cost, 2.8+0.06+2.0)
	if used == nil || used.Source != ListSource || used.Fetched != "2026-10-31" || used.CachedPerMTok != 0.20 {
		t.Fatalf("used = %+v", used)
	}
}

func TestListCostCallsAreAdditive(t *testing.T) {
	calls := []Tokens{
		{Input: i64(500000), Cached: i64(100000), Output: i64(50000)},
		{Input: i64(500000), Cached: i64(0), Output: i64(50000)},
	}
	cost, _ := ListCost("muse-wonder-1.0", nil, calls)
	almost(t, cost, 4.0+0.02+2.0)
}

func TestListCostMissingCountIsNone(t *testing.T) {
	model := "muse-wonder-1.0"
	for _, totals := range []*Tokens{
		{Cached: i64(1), Output: i64(1)},
		{Input: i64(1), Output: i64(1)},
		{Input: i64(1), Cached: i64(1)},
		{Input: i64(1), Cached: i64(5), Output: i64(1)}, // fresh < 0
	} {
		if cost, used := ListCost(model, totals, nil); cost != nil || used != nil {
			t.Errorf("totals %+v: got (%v, %v)", totals, cost, used)
		}
	}
	partial := []Tokens{{Input: i64(1), Output: i64(1)}}
	if cost, _ := ListCost(model, nil, partial); cost != nil {
		t.Error("partial calls must give nil")
	}
	if cost, _ := ListCost(model, nil, []Tokens{}); cost != nil {
		t.Error("no calls must give nil")
	}
	// No public price. Never borrowed from the other model.
	full := &Tokens{Input: i64(10), Cached: i64(0), Output: i64(10)}
	if cost, _ := ListCost("muse-wonder-full-1.0", full, nil); cost != nil {
		t.Error("unpriced model must give nil")
	}
}

func wantWindow(t *testing.T, w *Window, percent float64, resets int64) {
	t.Helper()
	if w == nil || w.UsedPercent == nil || *w.UsedPercent != percent ||
		w.ResetsAtMS == nil || *w.ResetsAtMS != resets {
		t.Fatalf("window = %+v, want %v/%v", w, percent, resets)
	}
}

func TestAllowanceSnapshotBothShapes(t *testing.T) {
	snap := Snapshot(loadUsage(t))
	if snap == nil {
		t.Fatal("want a snapshot from the CLI fixture")
	}
	wantWindow(t, snap.Window, 12, 1793554337000)
	wantWindow(t, snap.Weekly, 52, 1793577600000)

	stream := map[string]any{
		"tier": nil, "as_of_ms": 333.0, "source": "stream",
		"window": map[string]any{"used_percent": 3.0, "resets_at_ms": 111.0},
		"weekly": map[string]any{"used_percent": 19.0, "resets_at_ms": 222.0},
	}
	snap = Snapshot(stream)
	wantWindow(t, snap.Window, 3, 111)
	wantWindow(t, snap.Weekly, 19, 222)

	if Snapshot(nil) != nil || Snapshot(map[string]any{}) != nil {
		t.Error("empty input must give nil")
	}

	// A malformed limit is nil on its own. The other is kept.
	partial := loadUsage(t)
	delete(partial["allowance"].(map[string]any), "weekly")
	snap = Snapshot(partial)
	wantWindow(t, snap.Window, 12, 1793554337000)
	if snap.Weekly != nil {
		t.Error("missing weekly must stay nil")
	}

	partial = loadUsage(t)
	partial["allowance"].(map[string]any)["window"].(map[string]any)["usedPercent"] = "12"
	snap = Snapshot(partial)
	if snap.Window != nil {
		t.Error("string percent must lose the bucket")
	}
	wantWindow(t, snap.Weekly, 52, 1793577600000)

	partial = loadUsage(t)
	partial["allowance"] = map[string]any{"window": map[string]any{"usedPercent": "x"}}
	if Snapshot(partial) != nil {
		t.Error("both limits unusable must give nil")
	}
}

func win(percent float64, resets int64) *Window {
	return &Window{UsedPercent: &percent, ResetsAtMS: &resets}
}

func TestAllowanceDeltaAndResetGuard(t *testing.T) {
	start := &Allowance{Window: win(10, 100), Weekly: win(50, 200)}
	end := &Allowance{Window: win(12, 100), Weekly: win(51, 200)}
	d := AllowanceDelta(start, end)
	if d.Window == nil || *d.Window != 2 || d.Weekly == nil || *d.Weekly != 1 {
		t.Fatalf("delta = %+v", d)
	}
	d = AllowanceDelta(start, start)
	if *d.Window != 0 || *d.Weekly != 0 {
		t.Fatalf("same snapshot delta = %+v, want zeros", d)
	}
	reset := &Allowance{Window: win(1, 900), Weekly: win(51, 200)}
	d = AllowanceDelta(start, reset)
	if d.Window != nil || d.Weekly == nil || *d.Weekly != 1 {
		t.Fatalf("reset delta = %+v", d)
	}
	down := &Allowance{Window: win(9, 100), Weekly: win(51, 200)}
	d = AllowanceDelta(start, down)
	if d.Window != nil {
		t.Fatalf("downward percent must give nil, got %+v", d)
	}
	// Delta still lands for a surviving limit alone.
	lone := &Allowance{Window: win(10, 100)}
	d = AllowanceDelta(lone, end)
	if d.Window == nil || *d.Window != 2 || d.Weekly != nil {
		t.Fatalf("lone delta = %+v", d)
	}
	if d := AllowanceDelta(nil, end); d.Window != nil || d.Weekly != nil {
		t.Fatal("missing start must give an empty delta")
	}
	if d := AllowanceDelta(start, nil); d.Window != nil || d.Weekly != nil {
		t.Fatal("missing end must give an empty delta")
	}
}
