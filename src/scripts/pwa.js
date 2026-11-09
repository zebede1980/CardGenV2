// Installed-app support (plans/ios-app.md, Stages 1–2):
//  - "Update ready" bar: an installed app has no reload button and iOS keeps it
//    in memory for days, so a deploy would otherwise go unseen.
//  - The push service worker (sw.js) and the 🔔 Notifications sheet.
//  - ?open=<kind>&id=<id> links, which notifications open.
(function () {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toast = (msg, type = "info") => window.app?.showNotification?.(msg, type);

  const installed = () =>
    (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const isIOS = () =>
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // Something still generating: a reload would interrupt it (resume would
  // recover it, but don't make it).
  const busy = () => (window.wakeLockManager?._count || 0) > 0 || (window.ResumableJobs?.list?.().length || 0) > 0;

  // Resolves once the app has booted, which waits for a login if needed.
  function whenAppReady(timeoutMs = 10 * 60 * 1000) {
    return new Promise((resolve) => {
      const started = Date.now();
      (function poll() {
        if (window.app && window.homeHandler) return resolve(true);
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(poll, 200);
      })();
    });
  }

  // ── Update ready ───────────────────────────────────────────────────────────

  const Update = {
    base: null,
    lastCheck: 0,
    bar: null,

    async build() {
      try {
        const r = await fetch("/version.json", { cache: "no-store" });
        if (!r.ok) return null;
        return (await r.json()).build || null;
      } catch (e) {
        return null;
      }
    },

    async init() {
      this.base = await this.build();
      if (!this.base) return; // dev server: no version.json
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.check();
      });
      setInterval(() => { if (document.visibilityState === "visible") this.check(); }, 30 * 60 * 1000);
    },

    async check() {
      if (this.bar || Date.now() - this.lastCheck < 60 * 1000) return;
      this.lastCheck = Date.now();
      const latest = await this.build();
      if (latest && latest !== this.base) this.show();
    },

    show() {
      const bar = document.createElement("div");
      bar.id = "app-update-bar";
      bar.setAttribute("role", "status");
      bar.innerHTML = `<span>A new version is ready.</span>
        <button type="button" class="btn-primary aub-reload">Reload</button>
        <button type="button" class="aub-x" aria-label="Not now">✕</button>`;
      bar.querySelector(".aub-reload").addEventListener("click", () => {
        if (busy()) return toast("Something is still generating. Reload when it has finished.", "warning");
        location.reload();
      });
      bar.querySelector(".aub-x").addEventListener("click", () => { bar.hidden = true; });
      document.body.appendChild(bar);
      this.bar = bar;
    },
  };

  // ── Links from notifications ──────────────────────────────────────────────

  const ITEM_KINDS = ["roleplay", "messenger", "story", "adventure"];
  const TABS = {
    home: "tab-home", cardgen: "tab-cardgen", storywriter: "tab-storywriter", roleplay: "tab-roleplaychat",
    adventure: "tab-adventure", messenger: "tab-messenger", playground: "tab-playground",
  };

  async function openLink(href) {
    let u;
    try { u = new URL(href, location.href); } catch (e) { return; }
    if (u.origin !== location.origin) return;
    const kind = u.searchParams.get("open");
    const id = u.searchParams.get("id");
    if (!kind || !(await whenAppReady())) return;
    try {
      if (id && ITEM_KINDS.includes(kind)) {
        await window.homeHandler.openRecent({ kind, id });
      } else if (TABS[kind]) {
        document.getElementById(TABS[kind])?.click();
      }
    } catch (e) {
      console.warn("[pwa] could not open", href, e);
      document.getElementById("tab-home")?.click();
    }
  }

  function takeLaunchLink() {
    const params = new URLSearchParams(location.search);
    if (!params.has("open")) return;
    const href = location.href;
    params.delete("open");
    params.delete("id");
    const rest = params.toString();
    history.replaceState(history.state, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    openLink(href);
  }

  // ── Push ──────────────────────────────────────────────────────────────────

  const b64ToBytes = (s) => {
    const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  const bytesToB64 = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  function deviceLabel() {
    const ua = navigator.userAgent;
    const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || isIOS() ? "iPad"
      : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : "Computer";
    if (installed()) return `${device} · app`;
    const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome"
      : /Safari\//.test(ua) ? "Safari" : "browser";
    return `${device} · ${browser}`;
  }

  async function api(path, options = {}) {
    const r = await window.authFetch(`/api/sw/push${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    let body = null;
    try { body = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) throw new Error(body?.detail || body?.error || `Request failed (${r.status})`);
    return body;
  }

  const Push = {
    key: null,
    registration: null,

    supported: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,

    async register() {
      if (!("serviceWorker" in navigator)) return;
      try {
        this.registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      } catch (e) {
        console.warn("[pwa] service worker not registered:", e?.message || e);
      }
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "cardgen-open") openLink(event.data.url);
      });
    },

    async loadKey() {
      if (!this.key) this.key = (await api("/key")).public_key;
      return this.key;
    },

    async current() {
      const reg = this.registration || (await navigator.serviceWorker.getRegistration("/"));
      return reg ? reg.pushManager.getSubscription() : null;
    },

    async save(sub) {
      const json = sub.toJSON();
      return api("/subscribe", {
        method: "POST",
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, label: deviceLabel(), origin: location.origin }),
      });
    },

    // Call straight from the tap: iOS only shows the permission prompt for a
    // user gesture, so nothing is awaited before asking.
    async enable() {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error(permission === "denied"
          ? "Notifications are blocked for this site. Allow them in the device's settings, then try again."
          : "Notifications weren't allowed.");
      }
      const key = await this.loadKey();
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      const subKey = sub?.options?.applicationServerKey;
      if (sub && subKey && bytesToB64(subKey) !== key) {
        await sub.unsubscribe(); // made with an old server key: it can't be used
        sub = null;
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      return this.save(sub);
    },

    async disable() {
      const sub = await this.current();
      if (!sub) return;
      await api("/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      await sub.unsubscribe();
    },

    // On start: keep the server's copy of this device's subscription current
    // (renewed keys, a renamed device, a subscription renewed by sw.js).
    async sync() {
      if (!this.supported() || Notification.permission !== "granted") return;
      try {
        const sub = await this.current();
        if (sub) await this.save(sub);
      } catch (e) {
        console.debug("[pwa] push sync:", e?.message || e);
      }
    },
  };

  // ── 🔔 Notifications sheet ────────────────────────────────────────────────

  const Sheet = {
    el: null,

    async open() {
      this.close();
      const el = document.createElement("div");
      el.id = "notify-sheet";
      el.className = "pb-overlay";
      el.innerHTML = `
        <div class="pb-sheet" role="dialog" aria-modal="true" aria-label="Notifications">
          <div class="pb-scroll">
            <div class="pb-head"><h2>🔔 Notifications</h2><button type="button" class="ns-x" data-close aria-label="Close">✕</button></div>
            <section class="pb-panel">
              <h3>This device</h3>
              <p class="ns-state" data-state>Checking…</p>
              <div class="pb-row" data-actions></div>
              <div class="pb-error" data-error hidden></div>
            </section>
            <section class="pb-panel">
              <h3>Devices with notifications on</h3>
              <ul class="ns-devices" data-devices><li class="pb-hint">Loading…</li></ul>
            </section>
            <p class="pb-hint">For now there is only the test notification. Next: a notification when a card,
              picture, reply or story chapter you're waiting for is ready, and Messenger characters
              texting you first.</p>
          </div>
        </div>`;
      el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-close]")) this.close(); });
      // On the document: re-rendering the buttons drops focus out of the sheet.
      this.onKey = (e) => { if (e.key === "Escape") this.close(); };
      document.addEventListener("keydown", this.onKey);
      document.body.appendChild(el);
      document.documentElement.classList.add("saw-open");
      this.el = el;
      el.querySelector("[data-close]").focus();
      if (Push.supported()) Push.loadKey().catch(() => {}); // ready before the tap
      await this.render();
    },

    close() {
      if (!this.el) return;
      document.removeEventListener("keydown", this.onKey);
      this.el.remove();
      this.el = null;
      if (!document.querySelector(".pb-overlay:not([hidden])")) document.documentElement.classList.remove("saw-open");
    },

    error(msg) {
      const box = this.el?.querySelector("[data-error]");
      if (!box) return;
      box.textContent = msg || "";
      box.hidden = !msg;
    },

    button(label, cls, onClick) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.addEventListener("click", async () => {
        this.error("");
        b.disabled = true;
        try {
          await onClick();
        } catch (e) {
          this.error(e?.message || String(e));
        } finally {
          b.disabled = false;
          if (this.el) await this.render();
        }
      });
      return b;
    },

    async render() {
      const el = this.el;
      if (!el) return;
      const state = el.querySelector("[data-state]");
      const actions = el.querySelector("[data-actions]");
      actions.replaceChildren();

      if (!Push.supported()) {
        state.innerHTML = isIOS() && !installed()
          ? `On iPhone, notifications only work once the app is on your Home Screen. In Safari tap
             <b>Share</b> → <b>Add to Home Screen</b>, open CardGen from there, then come back here.`
          : "This browser can't receive push notifications.";
      } else {
        const sub = await Push.current().catch(() => null);
        if (Notification.permission === "denied") {
          state.textContent = "Notifications are blocked for this site. Allow them in the device's settings first.";
        } else if (sub) {
          state.textContent = `On for this device (${deviceLabel()}).`;
          actions.append(
            this.button("Send a test", "btn-primary", async () => {
              const r = await api("/test", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
              if (r.ok) toast("Test sent. It should arrive in a few seconds.", "success");
              else if (r.gone) throw new Error("This device's subscription had expired. Turn notifications on again.");
              else throw new Error(`The push service refused it: ${r.failed?.[0]?.error || "unknown error"}`);
            }),
            this.button("Turn off", "btn-outline", () => Push.disable()),
          );
        } else {
          state.textContent = "Off for this device.";
          actions.append(this.button("Turn on for this device", "btn-primary", () => Push.enable()));
        }
      }
      await this.renderDevices();
    },

    async renderDevices() {
      const list = this.el?.querySelector("[data-devices]");
      if (!list) return;
      let devices;
      try {
        devices = await api("/devices");
      } catch (e) {
        list.innerHTML = `<li class="pb-hint">Couldn't load the list: ${esc(e.message)}</li>`;
        return;
      }
      const mine = Push.supported() ? (await Push.current().catch(() => null))?.endpoint : null;
      if (!devices.length) {
        list.innerHTML = `<li class="pb-hint">None yet.</li>`;
        return;
      }
      list.replaceChildren(...devices.map((d) => {
        const li = document.createElement("li");
        const since = d.created_at ? new Date(d.created_at + (/[zZ+]/.test(d.created_at.slice(-6)) ? "" : "Z")) : null;
        li.innerHTML = `<span class="ns-name">${esc(d.label || "Unnamed device")}${d.endpoint === mine ? " <em>(this one)</em>" : ""}</span>
          <span class="pb-hint">${since ? "since " + esc(since.toLocaleDateString(undefined, { day: "numeric", month: "short" })) : ""}${d.last_error ? " · last push failed" : ""}</span>`;
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "ns-rm";
        rm.setAttribute("aria-label", `Remove ${d.label || "device"}`);
        rm.textContent = "✕";
        rm.addEventListener("click", async () => {
          rm.disabled = true;
          try {
            if (d.endpoint === mine) await Push.disable();
            else await api(`/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" });
          } catch (e) {
            this.error(e?.message || String(e));
          }
          if (this.el) this.render();
        });
        li.appendChild(rm);
        return li;
      }));
    },
  };

  // ── Start ─────────────────────────────────────────────────────────────────

  function init() {
    document.getElementById("notify-btn")?.addEventListener("click", () => Sheet.open());
    takeLaunchLink();
    Push.register().then(() => whenAppReady()).then((ok) => { if (ok) Push.sync(); });
    Update.init();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.cardgenPwa = { openLink, Push, Sheet, Update, installed };
})();
