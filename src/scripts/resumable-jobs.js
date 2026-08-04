/**
 * Tracking for resumable generations.
 *
 * A CardGen generation used to live only in browser memory: if iOS tore the
 * socket down while the phone was locked, the tokens were spent and the
 * character was gone. The proxy now buffers opted-in generations server-side
 * (see the job registry in proxy/server.js); this is the browser's half — it
 * remembers what is in flight and how much of it has already been seen.
 *
 * localStorage rather than sessionStorage on purpose: it survives a full tab
 * discard and reload, which is exactly the iOS memory-pressure case.
 */
const ResumableJobs = {
  STORAGE_KEY: "cardgen.pendingJobs",

  // Entries older than this are stale regardless of state — the server's own
  // retention window is shorter, so anything beyond it is unrecoverable.
  MAX_AGE_MS: 30 * 60 * 1000,

  newRef() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `ref-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  },

  _read() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  },

  _write(entries) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(entries));
    } catch (err) {
      // Quota or private-mode failure must never break generation itself.
      console.warn("[jobs] could not persist pending jobs:", err?.message || err);
    }
  },

  /** Drop anything too old to be recoverable. */
  prune() {
    const cutoff = Date.now() - this.MAX_AGE_MS;
    const kept = this._read().filter((e) => (e.startedAt || 0) > cutoff);
    this._write(kept);
    return kept;
  },

  list() {
    return this.prune();
  },

  get(clientRef) {
    return this._read().find((e) => e.clientRef === clientRef) || null;
  },

  add({ clientRef, label = "Generation" }) {
    const entries = this.prune().filter((e) => e.clientRef !== clientRef);
    entries.push({ clientRef, jobId: null, offset: 0, label, startedAt: Date.now() });
    this._write(entries);
  },

  update(clientRef, patch) {
    const entries = this._read();
    const entry = entries.find((e) => e.clientRef === clientRef);
    if (!entry) return;
    Object.assign(entry, patch);
    this._write(entries);
  },

  remove(clientRef) {
    this._write(this._read().filter((e) => e.clientRef !== clientRef));
  },

  clear() {
    this._write([]);
  },
};

window.ResumableJobs = ResumableJobs;
