package runner

import (
	"fmt"
	"strings"
)

// CompareModes are the --compare choices.
var CompareModes = []string{"meta", "claude", "custom"}

// ProviderModel is one compare leg.
type ProviderModel struct {
	Provider string
	Model    string
	HasModel bool
}

func metaModels() []string {
	return []string{"muse-wonder-1.0", "muse-wonder-full-1.0",
		"muse-spark-1.3", "muse-spark-1.2"}
}

func comparePreset(key, fallback string) string { return envOr(key, fallback) }

// ParseCompareModels parses a COMPARE_MODELS style list.
func ParseCompareModels(text string) []ProviderModel {
	var out []ProviderModel
	for _, entry := range strings.Split(text, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		provider, model, hasModel := entry, "", false
		if before, after, found := strings.Cut(entry, ":"); found {
			provider, model, hasModel = before, strings.TrimSpace(after), true
		} else {
			def, ok := DefaultModel(strings.TrimSpace(provider))
			model, hasModel = def, ok && def != ""
		}
		pm := ProviderModel{Provider: strings.TrimSpace(provider), Model: model, HasModel: hasModel && model != ""}
		if !pm.HasModel {
			pm.Model = ""
		}
		out = append(out, pm)
	}
	return out
}

// CompareModelsFor returns the legs for a compare mode.
// Preset env vars are read at call time.
func CompareModelsFor(mode string) ([]ProviderModel, error) {
	switch mode {
	case "meta":
		joined := ""
		for i, m := range metaModels() {
			if i > 0 {
				joined += ","
			}
			joined += "meta:" + m
		}
		return ParseCompareModels(comparePreset("COMPARE_META", joined)), nil
	case "claude":
		return ParseCompareModels(comparePreset(
			"COMPARE_CLAUDE", "claude-code:muse-wonder-1.0,claude-code:claude-sonnet-5-5")), nil
	case "custom", "":
		return ParseCompareModels(comparePreset(
			"COMPARE_MODELS",
			"meta:muse-wonder-1.0,claude-code:muse-wonder-1.0,claude-code:claude-sonnet-5-5")), nil
	}
	return nil, fmt.Errorf("unknown compare mode '%s' (valid: %s)",
		mode, strings.Join(CompareModes, ", "))
}

func modeLabel(mode string) string {
	switch mode {
	case "single":
		return "single"
	case "meta":
		return "meta vs meta"
	case "claude":
		return "meta vs claude"
	case "custom":
		return "custom"
	}
	return mode
}

// DescribeMode renders the mode line for the prompt loop.
func DescribeMode(mode string) string {
	if mode == "single" {
		return "Mode: single"
	}
	models, _ := CompareModelsFor(mode)
	parts := make([]string, 0, len(models))
	for _, m := range models {
		parts = append(parts, m.Provider+"/"+m.Model)
	}
	return fmt.Sprintf("Mode: %s (%s)", modeLabel(mode), strings.Join(parts, ", "))
}

// CommandResult classifies one prompt loop line.
type CommandResult struct {
	Action string // prompt, message, quit, or none
	Mode   string
	Text   string
}

// HandleCommand classifies one prompt loop line. It is pure:
// the passed mode is only read.
func HandleCommand(line, mode string) CommandResult {
	if mode == "" {
		mode = "single"
	}
	text := strings.TrimSpace(line)
	switch {
	case text == "":
		return CommandResult{Action: "none", Mode: mode}
	case text == "/quit" || text == "/exit" || text == "quit" || text == "exit":
		return CommandResult{Action: "quit", Mode: mode}
	case text == "/help":
		return CommandResult{Action: "message", Mode: mode, Text: "Commands: /mode, /mode single|meta|claude|custom, " +
			"/help, /quit\nModes: single (one run), meta (Meta vs Meta), " +
			"claude (Meta vs Claude), custom (COMPARE_MODELS)\n" +
			"Ctrl+C stops a run and records it as interrupted."}
	case text == "/mode":
		return CommandResult{Action: "message", Mode: mode, Text: DescribeMode(mode)}
	case strings.HasPrefix(text, "/mode "):
		wanted := strings.TrimSpace(strings.TrimPrefix(text, "/mode "))
		valid := wanted == "single"
		for _, m := range CompareModes {
			if wanted == m {
				valid = true
			}
		}
		if !valid {
			return CommandResult{Action: "message", Mode: mode,
				Text: fmt.Sprintf("Unknown mode '%s'. Valid modes: single, meta, claude, custom.", wanted)}
		}
		textOut := DescribeMode(wanted)
		if wanted == "claude" {
			seen := map[string]bool{}
			if models, err := CompareModelsFor("claude"); err == nil {
				for _, m := range models {
					if isPaid(m.Provider) {
						notice := PaidNotice(m.Model)
						if !seen[notice] {
							seen[notice] = true
							textOut += "\n" + notice
						}
					}
				}
			}
		}
		return CommandResult{Action: "message", Mode: wanted, Text: textOut}
	}
	return CommandResult{Action: "prompt", Mode: mode, Text: text}
}

// CompareSchedule gives one (round, order) pair per round.
// Even rounds reverse the order. It lands with step 4 because
// mode descriptions already need the model lists.
func CompareSchedule(models []ProviderModel, repeat int) []struct {
	Round int
	Order []ProviderModel
} {
	out := make([]struct {
		Round int
		Order []ProviderModel
	}, 0, repeat)
	for n := 1; n <= repeat; n++ {
		order := models
		if n%2 == 0 {
			order = make([]ProviderModel, len(models))
			for i, m := range models {
				order[len(models)-1-i] = m
			}
		}
		out = append(out, struct {
			Round int
			Order []ProviderModel
		}{Round: n, Order: order})
	}
	return out
}
