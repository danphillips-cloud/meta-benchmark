package main

import (
	"strings"
	"testing"
)

func TestParseArgsForms(t *testing.T) {
	args, msg, code := parseArgs([]string{"--provider", "echo", "hi", "there", "--minimal", "--timeout", "30"})
	if code != -1 || msg != "" {
		t.Fatalf("parse = %q %d", msg, code)
	}
	if args.provider != "echo" || !args.minimal || args.timeout == nil || *args.timeout != 30 {
		t.Errorf("args = %+v", args)
	}
	if strings.Join(args.promptWords, " ") != "hi there" {
		t.Errorf("prompt = %v", args.promptWords)
	}
	args, _, _ = parseArgs([]string{"--model=m2", "hi"})
	if args.model != "m2" || !args.hasModel {
		t.Errorf("equals form = %+v", args)
	}
}

func TestParseArgsErrors(t *testing.T) {
	for _, argv := range [][]string{
		{"--provider"},
		{"--compare"},
		{"--compare", "bogus", "hi"},
		{"--timeout", "soon"},
		{"--nope"},
	} {
		if _, msg, code := parseArgs(argv); code != 2 || msg == "" {
			t.Errorf("%v: got code %d msg %q", argv, code, msg)
		}
	}
	if _, msg, code := parseArgs([]string{"--compare"}); !strings.Contains(msg, "expected one argument") {
		t.Errorf("compare missing = %q code %d", msg, code)
	}
	if _, msg, code := parseArgs([]string{"--compare", "bogus", "hi"}); !strings.Contains(msg, "invalid choice") {
		t.Errorf("compare bogus = %q code %d", msg, code)
	}
	if _, msg, code := parseArgs([]string{"--help"}); code != 0 || !strings.Contains(msg, "usage:") {
		t.Errorf("help = %q code %d", msg, code)
	}
}
