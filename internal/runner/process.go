package runner

import (
	"bufio"
	"context"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// Verdict asks to stop the process at once because an
// approval prompt appeared. Tool may be nil when the approval
// record carried no tool name, matching run-muse.
type Verdict struct {
	Tool *string
}

// WatchFunc is polled while a process runs. A non-nil verdict
// stops the process the same way a timeout does.
type WatchFunc func() *Verdict

// StampedLine is one stdout line with its arrival stamp in ms.
type StampedLine struct {
	ArrivalMS int64
	Line      string
}

// ProcResult is the exit state of one harness process.
type ProcResult struct {
	WallMS        int64
	ExitCode      int
	TimedOut      bool
	Interrupted   bool
	Lines         []StampedLine
	NeedsApproval *string
}

// lineSink collects stamped lines for watchers that follow
// arrivals as they land.
type lineSink struct {
	mu    sync.Mutex
	lines []StampedLine
}

func (s *lineSink) append(line StampedLine) {
	s.mu.Lock()
	s.lines = append(s.lines, line)
	s.mu.Unlock()
}

func (s *lineSink) snapshot() []StampedLine {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]StampedLine(nil), s.lines...)
}

func pyRoundMS(d time.Duration) int64 {
	return int64(math.RoundToEven(float64(d) / float64(time.Millisecond)))
}

// RunProcess runs one harness process in its own process
// group, writing stdout to stdoutPath and stderr beside it.
// The context carries target-independent stops (race legs and
// Ctrl+C). Timeout and stops send SIGTERM to the group, then
// SIGKILL after 10 seconds, matching run-muse.
func RunProcess(ctx context.Context, argv []string, cwd string, env []string,
	stdoutPath string, timeoutSeconds int, inputText *string,
	watch WatchFunc, sink *lineSink) (ProcResult, error) {
	started := time.Now()
	if sink == nil {
		sink = &lineSink{}
	}
	outFile, err := os.Create(stdoutPath)
	if err != nil {
		return ProcResult{}, err
	}
	defer outFile.Close()
	errFile, err := os.Create(filepath.Join(filepath.Dir(stdoutPath), "stderr.log"))
	if err != nil {
		return ProcResult{}, err
	}
	defer errFile.Close()

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = errFile
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return ProcResult{}, err
	}
	var stdin io.WriteCloser
	if inputText != nil {
		stdin, err = cmd.StdinPipe()
		if err != nil {
			return ProcResult{}, err
		}
	}
	if err := cmd.Start(); err != nil {
		return ProcResult{}, err
	}

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		reader := bufio.NewReader(stdout)
		for {
			line, readErr := reader.ReadString('\n')
			if line != "" {
				sink.append(StampedLine{
					ArrivalMS: pyRoundMS(time.Since(started)), Line: line})
				_, _ = outFile.WriteString(line)
				_ = outFile.Sync()
			}
			if readErr != nil {
				return
			}
		}
	}()
	if inputText != nil {
		go func() {
			_, _ = io.WriteString(stdin, *inputText)
			_ = stdin.Close()
		}()
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	stop := func() int {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		select {
		case waitErr := <-done:
			return exitCodeOf(cmd, waitErr)
		case <-time.After(10 * time.Second):
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			waitErr := <-done
			return exitCodeOf(cmd, waitErr)
		}
	}

	result := ProcResult{}
	var deadline time.Time
	if timeoutSeconds > 0 {
		deadline = started.Add(time.Duration(timeoutSeconds) * time.Second)
	}
	exitCode := 0
loop:
	for {
		select {
		case waitErr := <-done:
			exitCode = exitCodeOf(cmd, waitErr)
			break loop
		case <-time.After(250 * time.Millisecond):
		}
		if watch != nil {
			if verdict := watch(); verdict != nil {
				result.NeedsApproval = verdict.Tool
				exitCode = stop()
				break loop
			}
		}
		select {
		case <-ctx.Done():
			result.Interrupted = true
			exitCode = stop()
			break loop
		default:
		}
		if !deadline.IsZero() && !time.Now().Before(deadline) {
			result.TimedOut = true
			exitCode = stop()
			break loop
		}
	}
	result.WallMS = pyRoundMS(time.Since(started))
	result.ExitCode = exitCode
	select {
	case <-readDone:
	case <-time.After(5 * time.Second):
	}
	result.Lines = sink.snapshot()
	return result, nil
}

func exitCodeOf(cmd *exec.Cmd, waitErr error) int {
	if cmd.ProcessState != nil {
		return cmd.ProcessState.ExitCode()
	}
	if waitErr != nil {
		return 1
	}
	return 0
}
