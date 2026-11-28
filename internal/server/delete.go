package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"meta-benchmark/internal/indexlock"
)

var runIDPattern = regexp.MustCompile(`^[0-9A-Za-z-]+$`)

func splitLines(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	text := string(data)
	lines := bytesSplitLines(text)
	return lines
}

// bytesSplitLines mirrors str.splitlines() for newline files.
func bytesSplitLines(text string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			line := text[start:i]
			lines = append(lines, trimSuffixCR(line))
			start = i + 1
		}
	}
	if start < len(text) {
		lines = append(lines, trimSuffixCR(text[start:]))
	}
	return lines
}

func trimSuffixCR(s string) string {
	if n := len(s); n > 0 && s[n-1] == '\r' {
		return s[:n-1]
	}
	return s
}

// DeleteRun removes one run from the index and deletes its
// directory. It refuses a run that is still running. The index
// rewrite is atomic and preserves the index file mode.
func (s *Server) DeleteRun(runID string) (bool, string) {
	if runID == "" || !runIDPattern.MatchString(runID) {
		return false, "invalid run id"
	}
	root, err := filepath.Abs(s.dataDir)
	if err != nil {
		return false, "invalid run id"
	}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	target := filepath.Join(root, runID)
	if filepath.Dir(target) != root {
		return false, "invalid run id"
	}
	indexPath := s.indexPath()
	var refused string
	lockErr := indexlock.Lock(indexPath, func() error {
		var latest runMap
		var kept []string
		data, readErr := os.ReadFile(indexPath)
		hasIndex := readErr == nil
		if hasIndex {
			for _, line := range splitLines(data) {
				dec := json.NewDecoder(bytes.NewReader([]byte(line)))
				dec.UseNumber()
				var entry map[string]any
				if err := dec.Decode(&entry); err != nil {
					kept = append(kept, line)
					continue
				}
				if getStr(entry, "run_id") == runID {
					latest = entry
				} else {
					kept = append(kept, line)
				}
			}
		}
		if latest != nil && getStr(latest, "status") == "running" {
			if _, err := os.Stat(filepath.Join(target, "report.json")); err != nil {
				if !isStaleRunning(latest) {
					refused = fmt.Sprintf("run %s is still running", runID)
					return nil
				}
			}
		}
		if hasIndex {
			info, err := os.Stat(indexPath)
			if err != nil {
				return err
			}
			mode := info.Mode().Perm()
			tmp, err := os.CreateTemp(filepath.Dir(indexPath), "index-*.tmp")
			if err != nil {
				return err
			}
			tmpName := tmp.Name()
			committed := false
			defer func() {
				if !committed {
					_ = os.Remove(tmpName)
				}
			}()
			for _, line := range kept {
				if _, err := tmp.WriteString(line + "\n"); err != nil {
					_ = tmp.Close()
					return err
				}
			}
			if err := tmp.Close(); err != nil {
				return err
			}
			if err := os.Chmod(tmpName, mode); err != nil {
				return err
			}
			if err := os.Rename(tmpName, indexPath); err != nil {
				return err
			}
			committed = true
		}
		if info, err := os.Stat(target); err == nil && info.IsDir() {
			return os.RemoveAll(target)
		}
		return nil
	})
	if refused != "" {
		return false, refused
	}
	if lockErr != nil {
		return false, lockErr.Error()
	}
	return true, ""
}
