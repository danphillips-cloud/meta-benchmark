// Command meta-benchmark is the Go launcher. It mirrors
// ./run-muse across providers, compare, watch, retro, and
// suites (steps 4 and 5 of the Go rewrite).
package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	webui "meta-benchmark"
	"meta-benchmark/internal/runner"
	"meta-benchmark/internal/server"
)

func main() { os.Exit(run(os.Args[1:])) }

type cliArgs struct {
	promptWords  []string
	provider     string
	model        string
	hasModel     bool
	minimal      bool
	timeout      *int
	compare      string
	hasCompare   bool
	repeat       *int
	race         bool
	watch        bool
	watchSession string
	retro        bool
	suite        bool
	suitePath    string
	dryRun       bool
	resume       bool
	fresh        bool
}

func cliError(format string, args ...any) (string, int) {
	return "meta-benchmark: error: " + fmt.Sprintf(format, args...), 2
}

func parseArgs(argv []string) (cliArgs, string, int) {
	args := cliArgs{provider: ""}
	nextValue := func(i *int, flag string) (string, bool) {
		if *i+1 >= len(argv) {
			return "", false
		}
		*i++
		return argv[*i], true
	}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		name, eqValue, hasEq := strings.Cut(arg, "=")
		valueFor := func() (string, bool) {
			if hasEq {
				return eqValue, true
			}
			return nextValue(&i, name)
		}
		switch name {
		case "--provider":
			v, ok := valueFor()
			if !ok {
				return args, "meta-benchmark: error: argument --provider: expected one argument", 2
			}
			args.provider = v
		case "--model":
			v, ok := valueFor()
			if !ok {
				return args, "meta-benchmark: error: argument --model: expected one argument", 2
			}
			args.model, args.hasModel = v, true
		case "--timeout":
			v, ok := valueFor()
			if !ok {
				return args, "meta-benchmark: error: argument --timeout: expected one argument", 2
			}
			n, err := strconv.Atoi(v)
			if err != nil {
				return args, fmt.Sprintf("meta-benchmark: error: argument --timeout: invalid int value: %q", v), 2
			}
			args.timeout = &n
		case "--compare":
			v, ok := valueFor()
			if !ok {
				return args, "meta-benchmark: error: argument --compare: expected one argument", 2
			}
			valid := false
			for _, m := range runner.CompareModes {
				if v == m {
					valid = true
				}
			}
			if !valid {
				return args, fmt.Sprintf("meta-benchmark: error: argument --compare: invalid choice: %q (choose from meta, claude, custom)", v), 2
			}
			args.compare, args.hasCompare = v, true
		case "--repeat":
			v, ok := valueFor()
			if !ok {
				return args, "meta-benchmark: error: argument --repeat: expected one argument", 2
			}
			n, err := strconv.Atoi(v)
			if err != nil {
				return args, fmt.Sprintf("meta-benchmark: error: argument --repeat: invalid int value: %q", v), 2
			}
			args.repeat = &n
		case "--minimal":
			args.minimal = true
		case "--race":
			args.race = true
		case "--retro":
			args.retro = true
		case "--dry-run":
			args.dryRun = true
		case "--resume":
			args.resume = true
		case "--fresh":
			args.fresh = true
		case "--watch":
			args.watch = true
			if hasEq {
				args.watchSession = eqValue
			} else if i+1 < len(argv) && !strings.HasPrefix(argv[i+1], "--") {
				i++
				args.watchSession = argv[i]
			}
		case "--suite", "--manifest":
			args.suite = true
			args.suitePath = runner.SuiteDefaultName
			if hasEq {
				args.suitePath = eqValue
			} else if i+1 < len(argv) && !strings.HasPrefix(argv[i+1], "--") {
				i++
				args.suitePath = argv[i]
			}
		case "--help", "-h":
			return args, "usage: meta-benchmark [--provider P] [--model M] [--minimal] [--timeout N] [prompt ...]\nWith no prompt, opens the prompt loop. Unported modes point at ./run-muse.", 0
		default:
			if strings.HasPrefix(arg, "-") && arg != "-" {
				return args, fmt.Sprintf("meta-benchmark: error: unrecognized arguments: %s", arg), 2
			}
			args.promptWords = append(args.promptWords, arg)
		}
	}
	return args, "", -1
}

func readOSReleaseForCLI() string {
	data, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return ""
	}
	return string(data)
}

func run(argv []string) int {
	// A launcher started from a non-interactive shell inherits
	// SIGINT as ignored. Restore the default disposition first,
	// then install our own handling for runs.
	signal.Reset(os.Interrupt)
	if len(argv) > 0 && argv[0] == "serve" {
		return runServe()
	}
	port, portMessage := server.UsePort()
	if portMessage != "" {
		fmt.Println(portMessage)
		return 2
	}
	args, parseMessage, parseCode := parseArgs(argv)
	if parseCode >= 0 {
		if parseMessage != "" {
			if parseCode == 0 {
				fmt.Println(parseMessage)
			} else {
				fmt.Fprintln(os.Stderr, parseMessage)
			}
		}
		return parseCode
	}
	if args.repeat != nil && !args.hasCompare && !args.suite {
		msg, code := cliError("--repeat needs --compare or --suite")
		fmt.Fprintln(os.Stderr, msg)
		return code
	}
	if args.race && !args.hasCompare {
		msg, code := cliError("--race needs --compare")
		fmt.Fprintln(os.Stderr, msg)
		return code
	}
	if args.suite && (len(args.promptWords) > 0 || args.hasCompare || args.watch || args.retro) {
		msg, code := cliError("--suite takes no prompt, --compare, --watch or --retro")
		fmt.Fprintln(os.Stderr, msg)
		return code
	}
	if (args.dryRun || args.resume || args.fresh) && !args.suite {
		msg, code := cliError("--dry-run, --resume and --fresh need --suite")
		fmt.Fprintln(os.Stderr, msg)
		return code
	}
	if args.fresh && !args.resume {
		msg, code := cliError("--fresh needs --resume")
		fmt.Fprintln(os.Stderr, msg)
		return code
	}
	if args.watch && (len(args.promptWords) > 0 || args.hasCompare) {
		msg, code := cliError("--watch takes no prompt or --compare")
		fmt.Fprintln(os.Stderr, msg)
		return code
	}
	if args.retro && (len(args.promptWords) > 0 || args.hasCompare || args.watch) {
		msg, code := cliError("--retro takes no prompt, --compare or --watch")
		fmt.Fprintln(os.Stderr, msg)
		return code
	}
	repeat := 1
	if args.repeat != nil {
		repeat = *args.repeat
	}
	if (args.hasCompare || args.suite) && repeat < 1 {
		msg, code := cliError("--repeat must be at least 1")
		fmt.Fprintln(os.Stderr, msg)
		return code
	}
	provider := args.provider
	if provider == "" {
		provider = runner.DefaultProvider()
	}

	dataDir := runner.ResolveDataDir()
	runner.LoadDefaultDotenv(dataDir)
	if warning := runner.DataDirWarning(dataDir,
		runner.IsWSL(os.Getenv, readOSReleaseForCLI())); warning != "" {
		fmt.Fprintln(os.Stderr, warning)
	}
	if _, err := runner.EnvPricing(); err != nil {
		msg, code := cliError("%s", err)
		fmt.Fprintln(os.Stderr, msg)
		return code
	}
	suiteModel := args.model
	model := args.model
	if !args.hasModel {
		if def, ok := runner.DefaultModel(provider); ok {
			model = def
		}
	}
	if !args.suite && !args.watch && !args.retro {
		if args.hasCompare {
			models, err := runner.CompareModelsFor(args.compare)
			if err != nil {
				msg, code := cliError("%s", err)
				fmt.Fprintln(os.Stderr, msg)
				return code
			}
			for _, leg := range models {
				if _, err := runner.ResolveModel(leg.Provider, leg.Model); err != nil {
					msg, code := cliError("%s", err)
					fmt.Fprintln(os.Stderr, msg)
					return code
				}
			}
		} else {
			resolved, err := runner.ResolveModel(provider, model)
			if err != nil {
				msg, code := cliError("%s", err)
				fmt.Fprintln(os.Stderr, msg)
				return code
			}
			model = resolved
		}
	}

	exe, _ := os.Executable()
	if exe == "" {
		exe = os.Args[0]
	}
	ui := &runner.UI{Port: port, DataDir: dataDir, ExecPath: exe,
		Out: os.Stdout, ErrOut: os.Stderr}
	r := runner.New(dataDir)

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, os.Interrupt)
	defer signal.Stop(sigCh)

	if args.suite {
		manifest, err := runner.LoadManifest(args.suitePath)
		if err != nil {
			msg, code := cliError("%s", err)
			fmt.Fprintln(os.Stderr, msg)
			return code
		}
		if args.resume && !args.fresh {
			if _, err := runner.LoadState(args.suitePath); err != nil {
				msg, code := cliError("%s", err)
				fmt.Fprintln(os.Stderr, msg)
				return code
			}
		}
		runner.ApplySuiteModel(manifest.Entries, provider, suiteModel)
		if err := runner.ValidateSuiteModels(manifest.Entries); err != nil {
			msg, code := cliError("%s", err)
			fmt.Fprintln(os.Stderr, msg)
			return code
		}
		if args.dryRun {
			code, runErr := r.RunSuite(context.Background(), args.suitePath,
				args.timeout, args.repeat, true, args.resume, args.fresh, manifest)
			if runErr != nil {
				fmt.Fprintln(os.Stderr, runErr)
				return 1
			}
			return code
		}
		ui.Ensure()
		r.UIURL = ui.URL()
		r.UIEnabled = ui.Enabled()
		ctx, cancel := runContext(sigCh)
		code, runErr := r.RunSuite(ctx, args.suitePath, args.timeout,
			args.repeat, false, args.resume, args.fresh, manifest)
		cancel()
		if runErr != nil {
			fmt.Fprintln(os.Stderr, runErr)
			return 1
		}
		return code
	}

	ui.Ensure()
	r.UIURL = ui.URL()
	r.UIEnabled = ui.Enabled()

	if args.watch {
		ctx, cancel := runContext(sigCh)
		r.RunWatch(ctx, args.watchSession)
		cancel()
		return 0
	}
	if args.retro {
		r.RunRetro()
		return 0
	}

	prompt := strings.TrimSpace(strings.Join(args.promptWords, " "))
	opts := runner.Options{Provider: provider, Model: model,
		Minimal: args.minimal, Timeout: args.timeout}
	if prompt != "" && args.hasCompare {
		ctx, cancel := runContext(sigCh)
		code, runErr := r.RunCompare(ctx, prompt, args.compare, args.minimal,
			args.timeout, repeat, args.race)
		cancel()
		if runErr != nil {
			fmt.Fprintln(os.Stderr, runErr)
			return 1
		}
		return code
	}
	if prompt != "" {
		ctx, cancel := runContext(sigCh)
		rep, runErr := r.RunPrompt(ctx, prompt, opts)
		cancel()
		if runErr != nil {
			fmt.Fprintln(os.Stderr, runErr)
			return 1
		}
		status := ""
		if rep.Status != nil {
			status = *rep.Status
		}
		return runner.ExitCodeFor(status)
	}

	contextLabel := "full"
	if args.minimal {
		contextLabel = "minimal"
	}
	mode := "single"
	if args.hasCompare {
		mode = args.compare
	}
	if mode == "single" {
		fmt.Printf("Model: %s/%s (%s context). Type a prompt, /quit to exit.%s\n",
			provider, model, contextLabel, r.UISuffix())
	} else {
		fmt.Printf("%s. Type a prompt, /mode to switch, /quit to exit.%s\n",
			runner.DescribeMode(mode), r.UISuffix())
	}
	reader := bufio.NewReader(os.Stdin)
	for {
		promptStr := "muse> "
		if mode != "single" {
			promptStr = "muse[" + mode + "]> "
		}
		fmt.Print(promptStr)
		line, interrupted := readLine(reader, sigCh)
		if interrupted {
			fmt.Println()
			break
		}
		if line == nil {
			fmt.Println()
			break
		}
		result := runner.HandleCommand(*line, mode)
		mode = result.Mode
		switch result.Action {
		case "quit":
			return 0
		case "message":
			fmt.Println(result.Text)
		case "prompt":
			ctx, cancel := runContext(sigCh)
			var runErr error
			if mode == "single" {
				_, runErr = r.RunPrompt(ctx, result.Text, opts)
			} else {
				_, runErr = r.RunCompare(ctx, result.Text, mode,
					args.minimal, args.timeout, repeat, args.race)
			}
			cancel()
			if runErr != nil {
				fmt.Fprintln(os.Stderr, runErr)
				continue
			}
			// A Ctrl+C that stopped the run was consumed by the
			// run context. The loop carries on, like run-muse.
		}
	}
	return 0
}

func readLine(reader *bufio.Reader, sigCh <-chan os.Signal) (*string, bool) {
	type result struct {
		line string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		line, err := reader.ReadString('\n')
		ch <- result{line, err}
	}()
	select {
	case <-sigCh:
		return nil, true
	case res := <-ch:
		if res.err != nil && res.line == "" {
			return nil, false
		}
		line := strings.TrimRight(res.line, "\n")
		return &line, false
	}
}

// runContext cancels when the next Ctrl+C lands on sigCh.
func runContext(sigCh <-chan os.Signal) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		select {
		case <-sigCh:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

func runServe() int {
	port, message := server.UsePort()
	if message != "" {
		fmt.Println(message)
		return 2
	}
	dataDir := runner.ResolveDataDir()
	srv := server.New(server.Config{DataDir: dataDir, WebFS: webui.Files(), Port: port})
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		fmt.Fprintln(os.Stderr, "Could not start the server:", err)
		return 1
	}
	srv.SetPort(port)
	if err := runner.WritePidfile(dataDir); err != nil {
		fmt.Fprintln(os.Stderr, "Could not write the server pidfile:", err)
	}
	defer runner.RemovePidfile(dataDir)
	httpServer := &http.Server{Handler: srv.Handler()}
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		_ = httpServer.Close()
	}()
	if err := httpServer.Serve(ln); err != nil && err != http.ErrServerClosed {
		if strings.Contains(err.Error(), "use of closed network connection") {
			return 0
		}
		fmt.Fprintln(os.Stderr, "Server stopped:", err)
		return 1
	}
	return 0
}
