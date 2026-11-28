package runner

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"sync"
)

func shortHex(n int) string {
	b := make([]byte, (n+1)/2)
	if _, err := cryptorand.Read(b); err != nil {
		return "00000000"[:n]
	}
	return hex.EncodeToString(b)[:n]
}

func reportStatus(status *string) string {
	if status == nil {
		return ""
	}
	return *status
}

// RunCompare runs one prompt across a mode's models and
// returns the aggregate exit code, like run-muse run_compare.
func (r *Runner) RunCompare(ctx context.Context, prompt, mode string,
	minimal bool, timeout *int, repeat int, race bool) (int, error) {
	comparisonID := shortHex(8)
	legs, err := CompareModelsFor(mode)
	if err != nil {
		return 2, err
	}
	models := make([]ProviderModel, 0, len(legs))
	for _, leg := range legs {
		resolved, err := ResolveModel(leg.Provider, leg.Model)
		if err != nil {
			return 2, err
		}
		models = append(models, ProviderModel{
			Provider: leg.Provider, Model: resolved, HasModel: true})
	}
	out := r.Out
	if out == nil {
		out = os.Stdout
	}
	verb := "Comparing"
	if race && len(models) > 1 {
		verb = "Racing"
	}
	fmt.Fprintf(out, "%s %d model(s), %d round(s), set %s\n",
		verb, len(models), repeat, comparisonID)
	var statuses []string
	for _, round := range CompareSchedule(models, repeat) {
		if race && len(round.Order) > 1 {
			roundStatuses, err := r.runRoundRaced(ctx, prompt, round.Order,
				minimal, timeout, comparisonID, round.Round, mode)
			if err != nil {
				return 1, err
			}
			statuses = append(statuses, roundStatuses...)
			if containsStatus(statuses, "interrupted") {
				break
			}
			continue
		}
		for _, leg := range round.Order {
			rep, err := r.RunPrompt(ctx, prompt, Options{
				Provider: leg.Provider, Model: leg.Model, Minimal: minimal,
				Timeout: timeout, ComparisonID: &comparisonID,
				Round: intPtr(round.Round), CompareMode: &mode,
			})
			if err != nil {
				return 1, err
			}
			status := reportStatus(rep.Status)
			statuses = append(statuses, status)
			if status == "interrupted" {
				break
			}
		}
		if containsStatus(statuses, "interrupted") {
			break
		}
	}
	done := 0
	for _, s := range statuses {
		if s == "completed" {
			done++
		}
	}
	closing := fmt.Sprintf("Compare set %s done: %d completed of %d.", comparisonID, done, len(statuses))
	if r.UIEnabled {
		closing += fmt.Sprintf(" UI: %scompare/%s", r.UIURL, comparisonID)
	}
	fmt.Fprintln(out, closing)
	if containsStatus(statuses, "interrupted") {
		return 130, nil
	}
	for _, s := range statuses {
		if s != "completed" {
			return 1, nil
		}
	}
	return 0, nil
}

func intPtr(v int) *int { return &v }

func containsStatus(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}

func (r *Runner) runRoundRaced(ctx context.Context, prompt string,
	order []ProviderModel, minimal bool, timeout *int,
	comparisonID string, roundNo int, mode string) ([]string, error) {
	legCtx, stopAll := context.WithCancel(ctx)
	defer stopAll()
	reports := make([]string, len(order))
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	for i, leg := range order {
		wg.Add(1)
		go func(index int, leg ProviderModel) {
			defer wg.Done()
			rep, err := r.RunPrompt(legCtx, prompt, Options{
				Provider: leg.Provider, Model: leg.Model, Minimal: minimal,
				Timeout: timeout, ComparisonID: &comparisonID,
				Round: intPtr(roundNo), CompareMode: &mode, Raced: true,
			})
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				reports[index] = "failed"
				return
			}
			reports[index] = reportStatus(rep.Status)
		}(i, leg)
	}
	wg.Wait()
	return reports, firstErr
}
