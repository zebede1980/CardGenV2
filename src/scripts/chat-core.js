/**
 * Shared pieces of the /api/sw reply streams, for 💌 Messenger (and any new
 * chat-like mode). Same rules as Roleplay Chat's own copy in chat-handler.js,
 * which hasn't been moved onto this yet (see STATUS.md):
 *
 * - The backend writes each reply in a task that outlives the connection and
 *   pings every 15 s. 45 s without a byte counts as a dropped connection.
 * - iOS freezes timers while the phone is locked and fires the overdue ones
 *   the instant it wakes, so the watchdog ignores time spent hidden or asleep.
 * - After a long sleep, the caller can ask the server whether the reply is
 *   already finished instead of waiting out the watchdog (live.checkServer).
 */
(function () {
    const STALL_MS = 45000;

    /**
     * Read an SSE response, calling onEvent(data) per `data:` event. Resolves
     * at the end of the stream or on a `done` event. Throws an error named
     * StreamStall when the watchdog fired. Returns the live handle via onLive.
     */
    async function readStream(res, controller, { onEvent, onLive, isFinished } = {}) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastByteAt = Date.now();
        let lastTick = Date.now();
        let stalled = false;
        const stall = () => { if (!stalled) { stalled = true; controller.abort(); } };
        const watchdog = setInterval(() => {
            const now = Date.now();
            const late = now - lastTick > 15000; // slept through ticks
            lastTick = now;
            if (document.visibilityState !== 'visible' || late) { lastByteAt = now; return; }
            if (now - lastByteAt > STALL_MS) stall();
        }, 5000);
        const live = {
            lastByteAt: () => lastByteAt,
            /** After a sleep: if the server already has the finished reply, stop waiting. */
            checkServer: async () => {
                try { if (isFinished && await isFinished()) stall(); } catch (_) { /* offline: keep waiting */ }
            },
        };
        onLive?.(live);
        try {
            while (true) {
                let result;
                try {
                    result = await reader.read();
                } catch (e) {
                    if (stalled) throw Object.assign(new Error('Reply stream stalled'), { name: 'StreamStall' });
                    throw e;
                }
                if (result.done) return;
                lastByteAt = Date.now();
                buffer += decoder.decode(result.value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop();
                for (const ev of events) {
                    if (!ev.startsWith('data: ')) continue; // `: ping` keep-alives
                    let data;
                    try { data = JSON.parse(ev.slice(6)); } catch (_) { continue; }
                    if (data.type === 'done') return;
                    onEvent?.(data);
                }
            }
        } finally {
            clearInterval(watchdog);
            onLive?.(null);
        }
    }

    /** POST a short utility call that streams one result event of `type`. */
    async function utilityCall(url, body, type) {
        const controller = new AbortController();
        const res = await window.authFetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}), signal: controller.signal,
        });
        if (!res.ok) throw new Error(await errorText(res));
        let result = null;
        let error = null;
        try {
            await readStream(res, controller, {
                onEvent: (ev) => { if (ev.type === type) result = ev; else if (ev.type === 'error') error = ev.message; },
            });
        } catch (e) {
            throw new Error(e.name === 'StreamStall' || e.name === 'AbortError' ? 'the connection dropped, try again' : e.message);
        }
        if (error) throw new Error(error);
        if (!result) throw new Error('nothing came back, try again');
        return result;
    }

    async function errorText(res) {
        try {
            const j = await res.json();
            return j.detail || j.error || `HTTP ${res.status}`;
        } catch (_) {
            return `HTTP ${res.status}`;
        }
    }

    /**
     * Mirror window.visualViewport into --{prefix}-vh / --{prefix}-vtop on
     * <html> while isActive() is true. iOS Safari pans the page for the
     * keyboard instead of resizing it, so a fixed 100dvh shell loses its
     * header; following the visual viewport keeps it in place.
     */
    function trackViewport(prefix, isActive, onChange) {
        const vv = window.visualViewport;
        const sync = () => {
            if (!vv || !isActive()) return;
            const root = document.documentElement.style;
            root.setProperty(`--${prefix}-vh`, `${Math.round(vv.height)}px`);
            root.setProperty(`--${prefix}-vtop`, `${Math.round(vv.offsetTop)}px`);
            document.body.classList.toggle(`${prefix}-kb-open`, window.innerHeight - vv.height > 120);
            onChange?.();
        };
        if (vv) {
            vv.addEventListener('resize', sync);
            vv.addEventListener('scroll', sync);
        }
        window.addEventListener('orientationchange', sync);
        return sync;
    }

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

    window.ChatCore = { STALL_MS, readStream, utilityCall, errorText, trackViewport, esc };
})();
