// Dev entry for the Go rewrite (plan steps 0 to 3). Embeds
// web/ and serves muse-runs through internal/server. The real
// command layout lands in step 4, when this becomes
// cmd/meta-benchmark plus internal/runner.
//
// Until the release cutover this entry defaults to port 8766
// and refuses 8765, so `go run .` can never collide with the
// live Python page. The server package itself implements the
// Python port contract, default 8765 included.
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"

	"meta-benchmark/internal/server"
)

const (
	devDefaultPort   = 8766
	forbiddenPort    = 8765
	devForbiddenText = "PORT 8765 is reserved for the Python page. Pick another port"
)

//go:embed web/index.html web/app.js web/style.css
var webFS embed.FS

// devPort resolves the dev entry port. It returns the port,
// a plain message to print, and an exit code.
func devPort() (int, string, int) {
	raw, present := os.LookupEnv("PORT")
	if !present {
		return devDefaultPort, "", 0
	}
	port, message := server.ParsePort(raw)
	if message != "" {
		return 0, message, 2
	}
	if port == forbiddenPort {
		return 0, devForbiddenText, 2
	}
	return port, "", 0
}

// resolveDataDir returns the muse-runs directory.
// META_BENCHMARK_HOME, when set, is the parent that holds
// muse-runs/. A value that itself holds index.jsonl is also
// accepted. The default is ./muse-runs.
func resolveDataDir() string {
	if home := os.Getenv("META_BENCHMARK_HOME"); home != "" {
		nested := filepath.Join(home, "muse-runs")
		if _, err := os.Stat(filepath.Join(nested, "index.jsonl")); err == nil {
			return nested
		}
		if _, err := os.Stat(filepath.Join(home, "index.jsonl")); err == nil {
			return home
		}
		return nested
	}
	return "muse-runs"
}

func main() {
	port, message, code := devPort()
	if code != 0 {
		fmt.Println(message)
		os.Exit(code)
	}
	web, err := fs.Sub(webFS, "web")
	if err != nil {
		fmt.Println("Could not load the embedded page:", err)
		os.Exit(1)
	}
	srv := server.New(server.Config{
		DataDir: resolveDataDir(), WebFS: web, Port: port})
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		fmt.Println("Could not start the server:", err)
		os.Exit(1)
	}
	if addr, ok := ln.Addr().(*net.TCPAddr); ok {
		srv.SetPort(addr.Port)
	}
	fmt.Printf("UI: http://127.0.0.1:%d/\n", srv.Port())
	if err := srv.Serve(ln); err != nil {
		fmt.Println("Server stopped:", err)
		os.Exit(1)
	}
}
