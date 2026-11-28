package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// Golden fixtures freeze the Python contracts (plan step 1).
// Regenerate with testdata/golden/make_golden.py only after a
// deliberate Python change, then review the diff. The /api/logs
// golden test lives in internal/server since step 3.

// decodePlain parses numbers as float64. Used for the Report
// round trip, where a struct float legitimately spells Python's
// 4.0 as 4. Values must match, spellings need not.
func decodePlain(t *testing.T, data []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func readGolden(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// equalJSON compares two decoded JSON values. A missing key and a
// present null count as the same unknown, because every Python
// reader uses .get(). The one exception in the codebase, the
// cache_creation_tokens presence test, is asserted separately
// through CacheCreationPresent.
func equalJSON(a, b any) bool {
	am, aIsMap := a.(map[string]any)
	bm, bIsMap := b.(map[string]any)
	if aIsMap && bIsMap {
		for k := range am {
			bv, ok := bm[k]
			if !ok {
				if am[k] != nil {
					return false
				}
				continue
			}
			if !equalJSON(am[k], bv) {
				return false
			}
		}
		for k := range bm {
			if _, ok := am[k]; !ok && bm[k] != nil {
				return false
			}
		}
		return true
	}
	as, aIsSlice := a.([]any)
	bs, bIsSlice := b.([]any)
	if aIsSlice && bIsSlice {
		if len(as) != len(bs) {
			return false
		}
		for i := range as {
			if !equalJSON(as[i], bs[i]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(a, b)
}

func TestGoldenReportRoundTrip(t *testing.T) {
	paths := []string{filepath.Join("testdata", "golden", "report.json")}
	more, err := filepath.Glob(filepath.Join("testdata", "golden", "runs", "*", "report.json"))
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(more)
	paths = append(paths, more...)
	if len(paths) < 2 {
		t.Fatalf("want the standalone golden plus per-run reports, got %v", paths)
	}
	for _, path := range paths {
		original := readGolden(t, path)
		var report Report
		if err := json.Unmarshal(original, &report); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		back, err := json.Marshal(report)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if !equalJSON(decodePlain(t, back), decodePlain(t, original)) {
			t.Errorf("%s: Report round trip changed the shape\nGo: %s\nOriginal: %s", path, back, original)
		}
	}
}

// The point of the pointer fields: null stays null, and a recorded
// zero stays a zero. Neither may turn into the other.
func TestReportNullVersusZero(t *testing.T) {
	var report Report
	if err := json.Unmarshal(readGolden(t, filepath.Join("testdata", "golden", "report.json")), &report); err != nil {
		t.Fatal(err)
	}
	if report.ComparisonID != nil || report.CostUSD != nil || report.Pricing != nil || report.Totals != nil || report.TurnIndex != nil {
		t.Fatal("want nil pointers where Python holds None")
	}
	if report.ApprovalMS == nil || *report.ApprovalMS != 0 {
		t.Fatalf("a recorded 0 approval must stay 0, got %v", report.ApprovalMS)
	}
	if report.TTFTMS == nil || *report.TTFTMS != 123 {
		t.Fatalf("ttft = %v", report.TTFTMS)
	}
	if len(report.Calls) != 2 || report.Calls[0].Model != nil || report.Calls[0].ReasoningTokens != nil {
		t.Fatalf("first call nulls lost: %+v", report.Calls)
	}
	if report.AllowanceDelta == nil || report.AllowanceDelta.Weekly != nil ||
		report.AllowanceDelta.Window == nil || *report.AllowanceDelta.Window != 2 {
		t.Fatalf("allowance delta = %+v", report.AllowanceDelta)
	}
	back, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"approval_ms":0`, `"comparison_id":null`, `"cost_usd":null`} {
		if !strings.Contains(string(back), want) {
			t.Errorf("marshaled report missing %s", want)
		}
	}
}

// Absent and present-null are different shapes for exactly one
// key. The struct must keep them apart.
func TestCacheCreationPresence(t *testing.T) {
	var legacy Report
	path := filepath.Join("testdata", "golden", "runs", "20260101-000007-an7h00", "report.json")
	if err := json.Unmarshal(readGolden(t, path), &legacy); err != nil {
		t.Fatal(err)
	}
	if len(legacy.Calls) != 2 {
		t.Fatalf("calls = %d", len(legacy.Calls))
	}
	if legacy.Calls[0].CacheCreationPresent {
		t.Error("first call: key absent, want CacheCreationPresent false")
	}
	if !legacy.Calls[1].CacheCreationPresent || legacy.Calls[1].CacheCreationTokens != nil {
		t.Error("second call: key present as null, want present with nil tokens")
	}
	var failed Report
	path = filepath.Join("testdata", "golden", "runs", "20260101-000002-fa11ed", "report.json")
	if err := json.Unmarshal(readGolden(t, path), &failed); err != nil {
		t.Fatal(err)
	}
	if failed.Totals == nil || !failed.Totals.CacheCreationPresent ||
		failed.Totals.CacheCreationTokens == nil || *failed.Totals.CacheCreationTokens != 0 {
		t.Errorf("totals cache creation = %+v", failed.Totals)
	}
}

// testdata/fixtures mirrors tests/fixtures byte for byte. When a
// Python fixture changes, this fails until the copy is refreshed.
func TestFixturesMirrorPython(t *testing.T) {
	pythonDir := filepath.Join("tests", "fixtures")
	goDir := filepath.Join("testdata", "fixtures")
	entries, err := os.ReadDir(pythonDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 11 {
		t.Fatalf("want 11 Python fixtures, got %d", len(entries))
	}
	for _, e := range entries {
		want, err := os.ReadFile(filepath.Join(pythonDir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join(goDir, e.Name()))
		if err != nil {
			t.Errorf("missing Go copy of %s", e.Name())
			continue
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s differs from the Python fixture", e.Name())
		}
	}
}
