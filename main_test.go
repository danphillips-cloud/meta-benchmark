package main

import (
	"os"
	"testing"
)

// The dev entry defaults to 8766 and refuses the Python page
// port. Full server behaviour is tested in internal/server.
func TestDevPort(t *testing.T) {
	// Unset PORT takes the dev default.
	os.Unsetenv("PORT")
	if port, _, code := devPort(); port != devDefaultPort || code != 0 {
		t.Fatalf("unset: got (%d,%d)", port, code)
	}
	cases := []struct {
		env      string
		wantPort int
		wantCode int
	}{
		{"", 0, 2},
		{"0", 0, 0},
		{"8766", 8766, 0},
		{"8765", 0, 2},
		{"abc", 0, 2},
		{"99999", 0, 2},
		{"-1", 0, 2},
	}
	for _, c := range cases {
		t.Setenv("PORT", c.env)
		port, message, code := devPort()
		if port != c.wantPort || code != c.wantCode {
			t.Errorf("PORT=%q: got (%d,%d), want (%d,%d)", c.env, port, code, c.wantPort, c.wantCode)
		}
		if c.wantCode != 0 && message == "" {
			t.Errorf("PORT=%q: want a plain message", c.env)
		}
		os.Unsetenv("PORT")
	}
	// The refusal text names the reserved port.
	t.Setenv("PORT", "8765")
	if _, message, _ := devPort(); message != devForbiddenText {
		t.Errorf("message = %q", message)
	}
}
