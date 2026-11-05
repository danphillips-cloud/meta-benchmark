"""Cross-process lock for index.jsonl writers. Stdlib only.

Shared by run-muse and server.py so both take the same lock.
"""
import contextlib
import fcntl


@contextlib.contextmanager
def index_file_lock(index_path):
    """Exclusive cross-process lock for index.jsonl writers.

    run-muse appends to the index while server.py can rewrite it
    for a delete. Every writer holds this flock on a file beside the
    index, so an append can never land between a delete's read and
    its rewrite and be lost. Platforms: macOS, Linux and Windows
    via WSL. fcntl works under WSL. Native Windows Python is not
    supported. The lock file is never deleted. The OS releases the
    lock when its holder exits.
    """
    index_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = index_path.parent / (index_path.name + ".lock")
    with open(lock_path, "a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
