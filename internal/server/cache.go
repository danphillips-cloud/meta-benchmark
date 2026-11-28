package server

import (
	"os"
	"sync"

	"meta-benchmark/internal/muselog"
	"meta-benchmark/internal/streams"
)

// lru is a small insertion-ordered cache. It keeps only the
// most recently used entries, so a long-lived server that has
// opened many runs does not keep them all.
type lru[K comparable, V any] struct {
	mu    sync.Mutex
	limit int
	order []K
	items map[K]V
}

func newLRU[K comparable, V any](limit int) *lru[K, V] {
	return &lru[K, V]{limit: limit, items: map[K]V{}}
}

func (c *lru[K, V]) get(key K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	value, ok := c.items[key]
	if !ok {
		return value, false
	}
	c.touchLocked(key)
	return value, true
}

func (c *lru[K, V]) put(key K, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.items[key]; !ok {
		c.order = append(c.order, key)
	} else {
		c.touchLocked(key)
	}
	c.items[key] = value
	for len(c.order) > c.limit {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.items, oldest)
	}
}

func (c *lru[K, V]) delete(key K) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.items[key]; !ok {
		return
	}
	delete(c.items, key)
	for i, k := range c.order {
		if k == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
}

func (c *lru[K, V]) touchLocked(key K) {
	for i, k := range c.order {
		if k == key {
			c.order = append(append(c.order[:i], c.order[i+1:]...), key)
			return
		}
	}
}

// recordsEntry caches parsed records against the file stamp.
// An appended line always changes the stamp or size, so a hit
// can never outlive new data.
type recordsEntry struct {
	mtimeNS int64
	size    int64
	records []muselog.Record
}

type claudeEntry struct {
	mtimeNS int64
	size    int64
	live    streams.Live
}

func fileStamp(path string) (mtimeNS int64, size int64, ok bool) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, 0, false
	}
	return info.ModTime().UnixNano(), info.Size(), true
}

// liveSessionLog resolves a session id to its log path, with
// the same stale-entry eviction as lib/server.py.
func (s *Server) liveSessionLog(sessionID string) (string, bool) {
	if sessionID == "" {
		return "", false
	}
	if cached, ok := s.sessionLogCache.get(sessionID); ok {
		if _, err := os.Stat(cached); err == nil {
			return cached, true
		}
		s.sessionLogCache.delete(sessionID)
		s.logRecordsCache.delete(cached)
	}
	path, found := muselog.SessionLogPath(sessionID)
	if !found {
		return "", false
	}
	s.sessionLogCache.put(sessionID, path)
	return path, true
}

// logRecords returns parsed records for path, cached by stamp.
// The bool reports whether a log was found at all, matching
// Python's None versus empty list distinction in read_logs.
func (s *Server) logRecords(path string) ([]muselog.Record, bool) {
	if path == "" {
		return nil, false
	}
	mtimeNS, size, ok := fileStamp(path)
	if !ok {
		s.logRecordsCache.delete(path)
		return nil, false
	}
	if cached, hit := s.logRecordsCache.get(path); hit {
		if cached.mtimeNS == mtimeNS && cached.size == size {
			return cached.records, true
		}
	}
	records := muselog.ReadRecords(path)
	s.logRecordsCache.put(path, recordsEntry{mtimeNS: mtimeNS, size: size, records: records})
	return records, true
}

func (s *Server) liveCalls(sessionID string) ([]muselog.Call, []muselog.TimelineRow) {
	path, ok := s.liveSessionLog(sessionID)
	if !ok {
		return nil, nil
	}
	records, found := s.logRecords(path)
	if !found {
		return nil, nil
	}
	return muselog.LiveCallsFromRecords(records)
}

// claudeLive returns live data for a running Claude Code run,
// parsed from its events.jsonl and cached against the stamp.
// The state pointer is nil when there is no events file yet.
func (s *Server) claudeLive(run runMap) (live streams.Live, has bool) {
	if getStr(run, "provider") != "claude-code" ||
		getStr(run, "status") != "running" || getStr(run, "run_id") == "" {
		return streams.Live{}, false
	}
	runID := getStr(run, "run_id")
	eventsFile := joinRunFile(s.dataDir, runID, "events.jsonl")
	if eventsFile == "" {
		return streams.Live{}, false
	}
	mtimeNS, size, ok := fileStamp(eventsFile)
	if !ok {
		return streams.Live{}, false
	}
	if cached, hit := s.claudeLiveCache.get(runID); hit {
		if cached.mtimeNS == mtimeNS && cached.size == size {
			return cached.live, true
		}
	}
	data, err := os.ReadFile(eventsFile)
	if err != nil {
		return streams.Live{}, false
	}
	live = streams.LiveFromLines(splitLines(data))
	s.claudeLiveCache.put(runID, claudeEntry{mtimeNS: mtimeNS, size: size, live: live})
	return live, true
}
