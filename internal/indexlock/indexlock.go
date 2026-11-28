// Package indexlock ports lib/index_lock.py: the
// cross-process lock for index.jsonl writers. It flocks
// index.jsonl.lock beside the index, the same file the Python
// runner and server use, so all writers exclude each other
// while both versions exist. The lock file is never deleted.
package indexlock

import (
	"os"
	"path/filepath"
	"syscall"
)

// Lock runs fn while holding the exclusive index lock.
func Lock(indexPath string, fn func() error) error {
	dir := filepath.Dir(indexPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	lockFile, err := os.OpenFile(indexPath+".lock", os.O_CREATE|os.O_RDWR, 0o666)
	if err != nil {
		return err
	}
	defer lockFile.Close()
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer func() { _ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN) }()
	return fn()
}
