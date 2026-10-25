// Read-only API client. The server is local-only and read-only apart
// from POST /api/delete; no keys ever reach the browser.

export async function fetchLogs(runId) {
  const q = runId ? "?run=" + encodeURIComponent(runId) : "";
  const resp = await fetch("/api/logs" + q);
  return resp.json();
}

export async function deleteRun(runId) {
  const resp = await fetch("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId }),
  });
  return resp.json().catch(() => ({}));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
