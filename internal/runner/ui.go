package runner

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"meta-benchmark/internal/server"
)

// UI manages the log page for one runner process. Server
// lifecycle uses a pidfile and a version check in the data
// dir, so no lsof or /proc hunt is needed on any platform.
type UI struct {
	Port     int
	DataDir  string
	ExecPath string // this binary, re-run with the hidden serve arg
	Out      io.Writer
	ErrOut   io.Writer

	blocked bool
	// Injectable for tests.
	FetchLogs   func() (map[string]any, bool)
	PortAccepts func() bool
	StartServer func() error
	OpenBrowser func(url string)
	KillPID     func(pid int) error
	PIDAlive    func(pid int) bool
}

// URL is the page address.
func (u *UI) URL() string { return fmt.Sprintf("http://127.0.0.1:%d/", u.Port) }

// Enabled reports whether the UI line should be shown.
func (u *UI) Enabled() bool {
	return os.Getenv("RUN_MUSE_NO_UI") == "" && !u.blocked
}

func (u *UI) pidfilePath() string { return filepath.Join(u.DataDir, "server.pid") }

func (u *UI) readPidfile() (int, bool) {
	data, err := os.ReadFile(u.pidfilePath())
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

// WritePidfile records this process as the UI server. The
// serve entry calls it at startup.
func WritePidfile(dataDir string) error {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dataDir, "server.pid"),
		[]byte(strconv.Itoa(os.Getpid())+"\n"), 0o644)
}

// RemovePidfile clears the pidfile when it names this process.
func RemovePidfile(dataDir string) {
	path := filepath.Join(dataDir, "server.pid")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	if strings.TrimSpace(string(data)) == strconv.Itoa(os.Getpid()) {
		_ = os.Remove(path)
	}
}

func (u *UI) fetchLogs() (map[string]any, bool) {
	if u.FetchLogs != nil {
		return u.FetchLogs()
	}
	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: &http.Transport{Proxy: nil},
	}
	resp, err := client.Get(u.URL() + "api/logs")
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	var logs map[string]any
	if json.NewDecoder(resp.Body).Decode(&logs) != nil {
		return nil, false
	}
	return logs, true
}

func (u *UI) portAccepts() bool {
	if u.PortAccepts != nil {
		return u.PortAccepts()
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", u.Port), 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func (u *UI) portInUseMessage() string {
	return fmt.Sprintf("Port %d is in use by another app. Set PORT to another port, e.g. PORT=%d meta-benchmark",
		u.Port, u.Port+1)
}

func (u *UI) block() {
	u.blocked = true
	errOut := u.ErrOut
	if errOut == nil {
		errOut = os.Stderr
	}
	fmt.Fprintln(errOut, u.portInUseMessage())
}

func (u *UI) startServer() error {
	if u.StartServer != nil {
		return u.StartServer()
	}
	if err := os.MkdirAll(u.DataDir, 0o755); err != nil {
		return err
	}
	logFile, err := os.OpenFile(filepath.Join(u.DataDir, "server.log"),
		os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o666)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd := exec.Command(u.ExecPath, "serve")
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	// Keys never reach the server. It never uses one.
	env := CleanEnv()
	env = append(env, "PORT="+strconv.Itoa(u.Port))
	if home := os.Getenv("META_BENCHMARK_HOME"); home != "" {
		env = append(env, "META_BENCHMARK_HOME="+home)
	}
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	for i := 0; i < 20; i++ {
		if _, ok := u.fetchLogs(); ok {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	return nil
}

func (u *UI) killPID(pid int) error {
	if u.KillPID != nil {
		return u.KillPID(pid)
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(syscall.SIGTERM)
}

func (u *UI) pidAlive(pid int) bool {
	if u.PIDAlive != nil {
		return u.PIDAlive(pid)
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

// restart stops a stale Go server proven ours by the pidfile,
// then starts a fresh one. A process we did not start is never
// signalled. The clash is named and left alone.
func (u *UI) restart() {
	pid, recorded := u.readPidfile()
	if !recorded || !u.pidAlive(pid) {
		u.block()
		return
	}
	_ = u.killPID(pid)
	for i := 0; i < 20; i++ {
		if _, ok := u.fetchLogs(); !ok {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	_ = u.startServer()
}

// Ensure makes the page reachable and opens it in a browser,
// like run-muse ensure_ui. A current server answering with
// the matching VERSION is reused as-is, whichever language
// serves it during the transition.
func (u *UI) Ensure() {
	if os.Getenv("RUN_MUSE_NO_UI") != "" {
		return
	}
	out := u.Out
	if out == nil {
		out = os.Stdout
	}
	logs, up := u.fetchLogs()
	switch {
	case !up:
		if u.portAccepts() {
			u.block()
			return
		}
		_ = u.startServer()
	case versionOf(logs) != server.Version:
		fmt.Fprintln(out, "Updating the log UI to the current version…")
		u.restart()
	}
	if u.Enabled() {
		u.openBrowser(u.URL())
	}
}

func versionOf(logs map[string]any) float64 {
	switch v := logs["version"].(type) {
	case float64:
		return v
	case json.Number:
		f, _ := v.Float64()
		return f
	}
	return -1
}

func (u *UI) openBrowser(url string) {
	if u.OpenBrowser != nil {
		u.OpenBrowser(url)
		return
	}
	argv := browserCommand(runtime.GOOS, IsWSL(os.Getenv, readOSRelease()), exec.LookPath, url)
	if len(argv) == 0 {
		return
	}
	_ = exec.Command(argv[0], argv[1:]...).Run()
}

func readOSRelease() string {
	data, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return ""
	}
	return string(data)
}

// IsWSL detects WSL from the standard markers.
func IsWSL(getenv func(string) string, osrelease string) bool {
	if getenv("WSL_DISTRO_NAME") != "" || getenv("WSL_INTEROP") != "" {
		return true
	}
	return strings.Contains(strings.ToLower(osrelease), "microsoft")
}

// BrowserCommand picks the opener argv for a platform. It
// returns nil when no opener is available. The printed UI line
// is the fallback, so a failed open is never a dead end.
func BrowserCommand(goos string, isWSL bool, lookPath func(string) (string, error), url string) []string {
	return browserCommand(goos, isWSL, lookPath, url)
}

func browserCommand(goos string, isWSL bool, lookPath func(string) (string, error), url string) []string {
	switch goos {
	case "darwin":
		return []string{"open", url}
	case "linux":
		if isWSL {
			if _, err := lookPath("wslview"); err == nil {
				return []string{"wslview", url}
			}
			return []string{"explorer.exe", url}
		}
		if _, err := lookPath("xdg-open"); err == nil {
			return []string{"xdg-open", url}
		}
	}
	return nil
}
