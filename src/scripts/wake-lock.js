/**
 * Screen Wake Lock manager.
 *
 * Holds the screen awake while a generation is in flight, so an iPhone left
 * untouched does not lock and tear down the streaming socket. This reduces how
 * often resume is needed but is not a correctness guarantee — it cannot stop a
 * manual power-button press, and browsers release the lock whenever the page is
 * hidden. Resume (see the job registry in proxy/server.js) remains the actual
 * safety net.
 *
 * Reference counted: concurrent generations ("Generate 4") each acquire, and
 * the lock drops only when the last one finishes.
 */
class WakeLockManager {
  constructor() {
    this._sentinel = null;
    this._count = 0;
    this._acquiring = null; // in-flight request(), so we never issue two
    this._safetyTimer = null;

    // navigator.wakeLock exists only in a secure context. The app is served
    // over HTTPS via NPM, but keep the guard for local http:// dev.
    this.supported =
      typeof navigator !== "undefined" && "wakeLock" in navigator;

    // Browsers auto-release the lock when the page is hidden, so it has to be
    // reclaimed on return if work is still outstanding.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this._count > 0) {
          this._request();
        }
      });
    }
  }

  /** Never let a leaked acquire() pin the screen on indefinitely. */
  static SAFETY_RELEASE_MS = 20 * 60 * 1000;

  async acquire() {
    this._count++;
    this._armSafetyTimer();
    await this._request();
  }

  /**
   * Drop one reference. Safe to call more times than acquire() — the count
   * floors at zero rather than going negative and stranding the sentinel.
   */
  release() {
    if (this._count > 0) this._count--;
    if (this._count === 0) this._releaseNow();
  }

  /** Drop every reference, e.g. when the user stops generation. */
  releaseAll() {
    this._count = 0;
    this._releaseNow();
  }

  get active() {
    return this._sentinel !== null;
  }

  async _request() {
    if (!this.supported || this._sentinel || this._acquiring) return;
    // request() rejects if the document is hidden; visibilitychange retries.
    if (document.visibilityState !== "visible") return;

    this._acquiring = navigator.wakeLock
      .request("screen")
      .then((sentinel) => {
        // Work may have finished while the request was in flight.
        if (this._count === 0) {
          sentinel.release().catch(() => {});
          return;
        }
        this._sentinel = sentinel;
        sentinel.addEventListener("release", () => {
          this._sentinel = null;
        });
      })
      .catch((err) => {
        // Denied by the OS (low battery), not in a secure context, or hidden.
        // Non-fatal: generation still works, the screen just may lock.
        console.debug("[wakeLock] request failed:", err?.message || err);
      })
      .finally(() => {
        this._acquiring = null;
      });

    await this._acquiring;
  }

  _releaseNow() {
    this._clearSafetyTimer();
    const sentinel = this._sentinel;
    this._sentinel = null;
    if (sentinel) sentinel.release().catch(() => {});
  }

  _armSafetyTimer() {
    this._clearSafetyTimer();
    this._safetyTimer = setTimeout(() => {
      if (this._count > 0) {
        console.warn(
          "[wakeLock] safety release after " +
            WakeLockManager.SAFETY_RELEASE_MS / 60000 +
            " min with " +
            this._count +
            " outstanding reference(s)",
        );
      }
      this.releaseAll();
    }, WakeLockManager.SAFETY_RELEASE_MS);
  }

  _clearSafetyTimer() {
    if (this._safetyTimer) {
      clearTimeout(this._safetyTimer);
      this._safetyTimer = null;
    }
  }
}

window.wakeLockManager = new WakeLockManager();
