// Package server ports lib/server.py: the local log viewer.
// It reads muse-runs/index.jsonl and serves it to the UI. It
// writes run data only to delete runs the user asks to delete.
// No API key is used here, and it binds 127.0.0.1 only.
package server

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
)

// Version mirrors lib/server.py VERSION. Bump both together
// while both servers exist, so launchers restart stale servers.
const Version = 78

// MaxBody is the largest POST body accepted. A delete body is a
// few dozen bytes.
const MaxBody = 64 * 1024

const (
	recordsCacheSize = 8
	pathCacheSize    = 256
)

// Config configures a Server. WebFS must hold index.html,
// app.js and style.css at its root. DataDir holds index.jsonl
// and the per-run directories.
type Config struct {
	DataDir string
	WebFS   fs.FS
	Port    int
}

// Server is the log viewer. Caches live on the instance, where
// Python uses module globals.
type Server struct {
	dataDir string
	webFS   fs.FS
	port    atomic.Int64

	sessionLogCache *lru[string, string]
	logRecordsCache *lru[string, recordsEntry]
	claudeLiveCache *lru[string, claudeEntry]
}

// New builds a Server from cfg.
func New(cfg Config) *Server {
	s := &Server{
		dataDir:         cfg.DataDir,
		webFS:           cfg.WebFS,
		sessionLogCache: newLRU[string, string](pathCacheSize),
		logRecordsCache: newLRU[string, recordsEntry](recordsCacheSize),
		claudeLiveCache: newLRU[string, claudeEntry](recordsCacheSize),
	}
	s.port.Store(int64(cfg.Port))
	return s
}

// SetPort records the port actually being listened on, for the
// Host check. Serve sets it from the listener. Tests using
// httptest set it from the test server URL.
func (s *Server) SetPort(port int) { s.port.Store(int64(port)) }

// Port returns the current listen port.
func (s *Server) Port() int { return int(s.port.Load()) }

func (s *Server) indexPath() string {
	return filepath.Join(s.dataDir, "index.jsonl")
}

// ParsePort parses a PORT value the way Python int() does for
// the tested shapes, plus the range check the plan adds. It
// returns (port, "") on success and (0, message) on bad input.
// The message names the raw value, whitespace included.
func ParsePort(raw string) (int, string) {
	port, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || port < 0 || port > 65535 {
		return 0, fmt.Sprintf("PORT must be a whole number, got %q", raw)
	}
	return port, ""
}

// UsePort reads PORT from the environment, defaulting to 8765
// like lib/server.py. A bad value is a startup error with a
// plain message, never a stack trace. An explicitly empty
// value is bad input, matching Python int("") failing, so
// presence is checked with LookupEnv rather than Getenv.
func UsePort() (int, string) {
	raw, present := os.LookupEnv("PORT")
	if !present {
		raw = "8765"
	}
	return ParsePort(raw)
}

func (s *Server) isLocalRequest(r *http.Request) bool {
	port := s.Port()
	host := r.Host
	if host != fmt.Sprintf("127.0.0.1:%d", port) && host != fmt.Sprintf("localhost:%d", port) {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		if origin != fmt.Sprintf("http://127.0.0.1:%d", port) &&
			origin != fmt.Sprintf("http://localhost:%d", port) {
			return false
		}
	}
	return true
}

func send(w http.ResponseWriter, code int, body []byte, ctype string) {
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(code)
	_, _ = w.Write(body)
}

func (s *Server) sendWeb(w http.ResponseWriter, name, ctype string) {
	body, err := fs.ReadFile(s.webFS, name)
	if err != nil {
		http.Error(w, "404 Not Found", http.StatusNotFound)
		return
	}
	send(w, http.StatusOK, body, ctype)
}

// Handler returns the HTTP handler for this server.
func (s *Server) Handler() http.Handler { return s }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.doGet(w, r)
	case http.MethodPost:
		s.doPost(w, r)
	default:
		http.Error(w, "404 Not Found", http.StatusNotFound)
	}
}

func (s *Server) doGet(w http.ResponseWriter, r *http.Request) {
	if !s.isLocalRequest(r) {
		http.Error(w, "403 Forbidden", http.StatusForbidden)
		return
	}
	switch r.URL.Path {
	case "/api/logs":
		body, err := json.Marshal(s.ReadLogs(r.URL.Query().Get("run")))
		if err != nil {
			http.Error(w, "500 Internal Server Error", http.StatusInternalServerError)
			return
		}
		send(w, http.StatusOK, body, "application/json")
	case "/app.js":
		s.sendWeb(w, "app.js", "text/javascript; charset=utf-8")
	case "/style.css":
		s.sendWeb(w, "style.css", "text/css; charset=utf-8")
	default:
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.Error(w, "404 Not Found", http.StatusNotFound)
			return
		}
		// /, /index.html, and every deep link load the app
		// shell. The client router picks the view.
		s.sendWeb(w, "index.html", "text/html; charset=utf-8")
	}
}

func (s *Server) doPost(w http.ResponseWriter, r *http.Request) {
	if !s.isLocalRequest(r) {
		http.Error(w, "403 Forbidden", http.StatusForbidden)
		return
	}
	if r.URL.Path != "/api/delete" {
		http.Error(w, "404 Not Found", http.StatusNotFound)
		return
	}
	// A bad length must be refused, and a negative one must
	// never make the read wait for the client to close.
	rawLen := r.Header.Get("Content-Length")
	length := 0
	if rawLen != "" {
		parsed, err := strconv.Atoi(rawLen)
		if err != nil {
			length = -1
		} else {
			length = parsed
		}
	}
	if length < 0 || length > MaxBody {
		http.Error(w, "400 Bad Request", http.StatusBadRequest)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, int64(length)))
	var data map[string]any
	if err := json.Unmarshal(bodyOrObject(body, length), &data); err != nil {
		data = map[string]any{}
	}
	ok, reason := s.DeleteRun(pyStr(data["run_id"]))
	var reasonValue any
	if reason != "" {
		reasonValue = reason
	}
	out, _ := json.Marshal(map[string]any{"ok": ok, "reason": reasonValue})
	code := http.StatusBadRequest
	if ok {
		code = http.StatusOK
	}
	send(w, code, out, "application/json")
}

func bodyOrObject(body []byte, length int) []byte {
	if length == 0 || len(body) == 0 {
		return []byte("{}")
	}
	return body
}

// pyStr mirrors str(value or "") for JSON scalars.
func pyStr(v any) string {
	switch n := v.(type) {
	case string:
		return n
	case float64:
		if n == 0 {
			return ""
		}
		return strconv.FormatFloat(n, 'g', -1, 64)
	case json.Number:
		if n.String() == "0" {
			return ""
		}
		return n.String()
	case bool:
		if n {
			return "True"
		}
		return ""
	}
	return ""
}

// Serve serves on ln until it fails. It records the bound port
// first so Host checks see the real one when port 0 was used.
func (s *Server) Serve(ln net.Listener) error {
	if addr, ok := ln.Addr().(*net.TCPAddr); ok {
		s.SetPort(addr.Port)
	}
	return http.Serve(ln, s)
}

// ListenAndServe binds 127.0.0.1 on the configured port. It
// never binds a wider interface, including under WSL.
func (s *Server) ListenAndServe() error {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.Port()))
	if err != nil {
		return err
	}
	return s.Serve(ln)
}
