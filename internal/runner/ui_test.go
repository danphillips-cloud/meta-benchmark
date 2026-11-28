package runner

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"meta-benchmark/internal/server"
)

func TestIsWSLDetection(t *testing.T) {
	env := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}
	cases := []struct {
		env       map[string]string
		osrelease string
		want      bool
	}{
		{map[string]string{"WSL_DISTRO_NAME": "Ubuntu"}, "", true},
		{map[string]string{"WSL_INTEROP": "/run/WSL/1_interop"}, "", true},
		{map[string]string{}, "5.15.90.1-microsoft-standard-WSL2", true},
		{map[string]string{}, "6.8.0-31-generic", false},
		{map[string]string{}, "", false},
	}
	for i, c := range cases {
		if got := IsWSL(env(c.env), c.osrelease); got != c.want {
			t.Errorf("case %d = %v want %v", i, got, c.want)
		}
	}
}

func TestBrowserCommandSelection(t *testing.T) {
	look := func(found map[string]bool) func(string) (string, error) {
		return func(name string) (string, error) {
			if found[name] {
				return "/usr/bin/" + name, nil
			}
			return "", os.ErrNotExist
		}
	}
	url := "http://127.0.0.1:8765/"
	cases := []struct {
		goos string
		wsl  bool
		have map[string]bool
		want []string
	}{
		{"darwin", false, nil, []string{"open", url}},
		{"linux", false, map[string]bool{"xdg-open": true}, []string{"xdg-open", url}},
		{"linux", false, map[string]bool{}, nil},
		{"linux", true, map[string]bool{"wslview": true}, []string{"wslview", url}},
		{"linux", true, map[string]bool{}, []string{"explorer.exe", url}},
		{"windows", false, nil, nil},
	}
	for i, c := range cases {
		got := BrowserCommand(c.goos, c.wsl, look(c.have), url)
		if strings.Join(got, " ") != strings.Join(c.want, " ") {
			t.Errorf("case %d = %v want %v", i, got, c.want)
		}
	}
}

func newFakeUI(t *testing.T) (*UI, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	out, errOut := &bytes.Buffer{}, &bytes.Buffer{}
	ui := &UI{Port: 19876, DataDir: t.TempDir(), Out: out, ErrOut: errOut}
	return ui, out, errOut
}

func TestEnsureReusesCurrentServer(t *testing.T) {
	ui, _, _ := newFakeUI(t)
	started, opened := false, ""
	ui.FetchLogs = func() (map[string]any, bool) {
		return map[string]any{"version": float64(server.Version)}, true
	}
	ui.StartServer = func() error { started = true; return nil }
	ui.OpenBrowser = func(url string) { opened = url }
	ui.Ensure()
	if started {
		t.Error("a current server must be reused, not restarted")
	}
	if opened != ui.URL() {
		t.Errorf("opened = %q", opened)
	}
	if !ui.Enabled() {
		t.Error("UI must stay enabled")
	}
}

func TestEnsureStartsWhenDownAndBlocksWhenForeign(t *testing.T) {
	ui, _, _ := newFakeUI(t)
	started := false
	ui.FetchLogs = func() (map[string]any, bool) { return nil, false }
	ui.PortAccepts = func() bool { return false }
	ui.StartServer = func() error { started = true; return nil }
	ui.OpenBrowser = func(string) {}
	ui.Ensure()
	if !started {
		t.Error("a free port must start the server")
	}

	ui, _, errOut := newFakeUI(t)
	started = false
	ui.FetchLogs = func() (map[string]any, bool) { return nil, false }
	ui.PortAccepts = func() bool { return true }
	ui.StartServer = func() error { started = true; return nil }
	ui.Ensure()
	if started {
		t.Error("a foreign listener must never be started over")
	}
	if ui.Enabled() {
		t.Error("UI must be blocked when a foreign app holds the port")
	}
	if !strings.Contains(errOut.String(), "Port 19876 is in use by another app") {
		t.Errorf("stderr = %q", errOut.String())
	}
}

func TestEnsureRestartsOnlyPidfileServer(t *testing.T) {
	ui, out, _ := newFakeUI(t)
	killed := 0
	started := false
	up := true
	ui.FetchLogs = func() (map[string]any, bool) {
		if !up {
			return nil, false
		}
		return map[string]any{"version": float64(server.Version - 1)}, true
	}
	ui.KillPID = func(pid int) error { killed = pid; up = false; return nil }
	ui.PIDAlive = func(pid int) bool { return pid == 4242 }
	ui.StartServer = func() error { started = true; return nil }
	ui.OpenBrowser = func(string) {}
	if err := os.WriteFile(filepath.Join(ui.DataDir, "server.pid"), []byte("4242\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ui.Ensure()
	if killed != 4242 || !started {
		t.Errorf("killed=%d started=%v", killed, started)
	}
	if !strings.Contains(out.String(), "Updating the log UI") {
		t.Errorf("out = %q", out.String())
	}

	// Same stale answer without a pidfile: never signalled.
	ui, _, errOut := newFakeUI(t)
	killed = 0
	ui.FetchLogs = func() (map[string]any, bool) {
		return map[string]any{"version": float64(server.Version - 1)}, true
	}
	ui.KillPID = func(pid int) error { killed = pid; return nil }
	ui.PIDAlive = func(int) bool { return true }
	ui.StartServer = func() error { return nil }
	ui.Ensure()
	if killed != 0 {
		t.Errorf("an unrecorded process must never be killed, got %d", killed)
	}
	if ui.Enabled() || !strings.Contains(errOut.String(), "in use") {
		t.Errorf("blocked state lost: enabled=%v err=%q", ui.Enabled(), errOut.String())
	}
}

func TestPidfileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if err := WritePidfile(dir); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "server.pid"))
	if err != nil || strings.TrimSpace(string(data)) != strconv.Itoa(os.Getpid()) {
		t.Fatalf("pidfile = %q %v", data, err)
	}
	RemovePidfile(dir)
	if _, err := os.Stat(filepath.Join(dir, "server.pid")); !os.IsNotExist(err) {
		t.Error("pidfile must be removed for the owning process")
	}
	// A foreign pid in the file is left alone.
	if err := os.WriteFile(filepath.Join(dir, "server.pid"), []byte("999999\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	RemovePidfile(dir)
	if _, err := os.Stat(filepath.Join(dir, "server.pid")); err != nil {
		t.Error("a foreign pidfile must be left alone")
	}
}
