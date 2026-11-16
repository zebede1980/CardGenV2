// 🔒 App lock: a PIN screen over the app.
//
//  - The PIN belongs to the account and is checked by the proxy
//    (/api/auth/pin*), which also limits wrong guesses.
//  - Whether a device asks for it is that device's own setting (localStorage),
//    so the phone can lock while the PC stays open.
//  - It locks when the app is opened, and when you come back after being away
//    longer than the device's "lock after" time.
//
// It is a privacy screen and nothing more: an opaque layer on top of the app.
// The app keeps running underneath, so a generation that is streaming, resuming
// or waiting to be collected carries on while the PIN is being asked for. Never
// make locking pause, abort or reload anything.
//
// There is no text field anywhere in the PIN entry: it is a keypad of buttons,
// so iOS never offers to save or fill the PIN from the Passwords app.
(function () {
  "use strict";

  const KEY = "cardgen.appLock.v1";
  const MIN = 4;
  const MAX = 8;
  const DEFAULT_AFTER = 300;
  const REQUEST_MS = 12000;
  const AFTER = [
    [0, "Every time I leave the app"],
    [60, "After 1 minute away"],
    [300, "After 5 minutes away"],
    [900, "After 15 minutes away"],
    [3600, "After an hour away"],
  ];

  const toast = (msg, type = "info") => window.app?.showNotification?.(msg, type);

  // ── This device's setting ─────────────────────────────────────────────────

  const Device = {
    read() {
      try {
        const d = JSON.parse(localStorage.getItem(KEY) || "null");
        return d && typeof d === "object" ? d : null;
      } catch (e) {
        return null;
      }
    },
    write(patch) {
      const next = { ...(this.read() || {}), ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* private mode: no lock */ }
      return next;
    },
    clear() {
      try { localStorage.removeItem(KEY); } catch (e) { /* nothing to clear */ }
    },
  };

  const currentUser = () => String(window.cardgenAuth?.getStoredUser?.()?.username || "").toLowerCase();

  // On for this device, and for the account that is signed in on it.
  function enabled() {
    const d = Device.read();
    return !!(d && d.on && d.user && window.cardgenAuth?.getToken?.() && d.user === currentUser());
  }

  // ── Server ────────────────────────────────────────────────────────────────

  // Every request is cut off after REQUEST_MS: a connection that goes silent
  // without closing must not leave the keypad waiting for ever. The timer can
  // fire late after the phone was asleep and cut off a request that was fine;
  // that only costs the one retry in checkPin().
  async function api(path, method = "GET", body) {
    const cut = new AbortController();
    const timer = setTimeout(() => cut.abort(), REQUEST_MS);
    let r;
    let data = null;
    try {
      r = await window.authFetch(`/api/auth/pin${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: cut.signal,
      });
      try { data = await r.json(); } catch (e) { if (cut.signal.aborted) throw e; }
    } catch (e) {
      const err = new Error("Couldn't reach the server. Check the connection and try again.");
      err.network = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      const err = new Error(data?.error || `Request failed (${r.status})`);
      err.status = r.status;
      err.data = data || {};
      throw err;
    }
    return data;
  }

  // → { ok } | { gone } | { wrong, left, wait, length } | { wait } | { error }
  async function checkPin(pin) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await api("/verify", "POST", { pin });
        if (r.ok) return { ok: true };
        if (r.set === false) return { gone: true };
        return { wrong: true, left: r.attemptsLeft || 0, wait: r.retryAfter || 0, length: r.length || 0 };
      } catch (e) {
        // The first request after the phone wakes can land on a dead
        // connection. One more go, rather than making you type the PIN again.
        if (e.network && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        if (e.status === 429) return { wait: e.data?.retryAfter || 30 };
        return { error: e.message || "Couldn't check the PIN." };
      }
    }
  }

  const wrongText = (r) =>
    r.left > 0 ? `Wrong PIN. ${r.left} ${r.left === 1 ? "try" : "tries"} left before a wait.` : "Wrong PIN.";

  // Applies a checkPin() result to the keypad it came from. True when right.
  function applyCheck(pad, r) {
    if (r.ok) return true;
    if (r.length && r.length !== pad.length) pad.configure({ length: r.length });
    if (r.wait) pad.wait(r.wait);
    pad.fail(r.wrong ? wrongText(r) : r.error || "");
    return false;
  }

  // ── Keypad ────────────────────────────────────────────────────────────────
  // length > 0: the PIN is sent as soon as that many digits are in.
  // length 0:   any length from MIN to MAX, sent with OK.

  const pads = new Set();

  function makePad({ onSubmit }) {
    const el = document.createElement("div");
    el.className = "al-padwrap";
    const key = (k, label, cls = "", aria = "") =>
      `<button type="button" class="al-key ${cls}" data-key="${k}"${aria ? ` aria-label="${aria}"` : ""}>${label}</button>`;
    el.innerHTML = `
      <div class="al-dots" aria-hidden="true"></div>
      <p class="al-msg" role="status" aria-live="polite"></p>
      <div class="al-pad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => key(n, n)).join("")}
        ${key("ok", "OK", "al-ok", "Done")}
        ${key(0, 0)}
        ${key("del", "⌫", "al-del", "Delete")}
      </div>`;
    const dots = el.querySelector(".al-dots");
    const msg = el.querySelector(".al-msg");

    const pad = {
      el,
      value: "",
      length: 0,
      busy: false,
      until: 0,
      timer: null,

      waiting() { return Date.now() < this.until; },

      configure({ length = 0 } = {}) {
        this.length = length >= MIN && length <= MAX ? length : 0;
        this.value = "";
        this.render();
      },

      say(text) { msg.textContent = text || ""; },

      render() {
        const shown = this.length || Math.max(MIN, this.value.length);
        dots.replaceChildren(...Array.from({ length: shown }, (_, i) => {
          const dot = document.createElement("span");
          if (i < this.value.length) dot.className = "on";
          return dot;
        }));
        const blocked = this.busy || this.waiting();
        el.classList.toggle("al-blocked", blocked);
        el.querySelectorAll(".al-key").forEach((b) => { b.disabled = blocked; });
        const ok = el.querySelector(".al-ok");
        ok.classList.toggle("al-none", !!this.length); // keeps its place in the grid
        if (!blocked) ok.disabled = this.value.length < MIN;
      },

      press(k) {
        if (this.busy || this.waiting()) return;
        if (k === "del") {
          this.value = this.value.slice(0, -1);
        } else if (k === "ok") {
          if (!this.length && this.value.length >= MIN) return this.submit();
        } else if (/^\d$/.test(k) && this.value.length < (this.length || MAX)) {
          if (!this.value) this.say("");
          this.value += k;
          if (this.length && this.value.length === this.length) return this.submit();
        }
        this.render();
      },

      async submit() {
        const pin = this.value;
        this.busy = true;
        this.render();
        try {
          await onSubmit(pin, this);
        } finally {
          this.busy = false;
          this.render();
        }
      },

      fail(text) {
        this.value = "";
        if (text && !this.waiting()) this.say(text);
        el.classList.remove("al-shake");
        void el.offsetWidth; // restart the animation
        el.classList.add("al-shake");
        this.render();
      },

      // The server refuses guesses for this long. The countdown is worked out
      // from the clock on every tick, so a timer frozen while the phone was
      // locked just shows the right time when it wakes.
      wait(seconds) {
        this.until = Date.now() + seconds * 1000;
        this.value = "";
        if (!this.timer) this.timer = setInterval(() => this.tick(), 500);
        this.tick();
      },

      tick() {
        const left = Math.ceil((this.until - Date.now()) / 1000);
        if (left <= 0) {
          if (this.timer) clearInterval(this.timer);
          this.timer = null;
          if (this.until) this.say("");
          this.until = 0;
        } else {
          const m = Math.floor(left / 60);
          this.say(`Too many wrong tries. Try again in ${m}:${String(left % 60).padStart(2, "0")}.`);
        }
        this.render();
      },

      destroy() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        pads.delete(this);
      },
    };

    el.addEventListener("click", (e) => {
      const b = e.target.closest(".al-key");
      if (b) pad.press(b.dataset.key);
    });
    pads.add(pad);
    pad.render();
    return pad;
  }

  // ── The lock screen ───────────────────────────────────────────────────────
  //  open     nothing shown
  //  covered  the page went into the background: a blank cover, so the app
  //           switcher's snapshot (best effort) and the first frame back show
  //           nothing. Coming back in time removes it; too late asks for the PIN.
  //  locked   asking for the PIN

  const Lock = {
    state: "open",
    el: null,
    pad: null,
    hiddenAt: 0,
    waiters: [],

    build() {
      if (this.el) return;
      const el = document.createElement("div");
      el.id = "app-lock";
      el.hidden = true;
      el.tabIndex = -1;
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.setAttribute("aria-label", "CardGen is locked");
      el.innerHTML = `
        <div class="al-box">
          <div class="al-icon" aria-hidden="true">🔒</div>
          <h2 class="al-title">Enter your PIN</h2>
          <div class="al-pin" data-pad></div>
          <button type="button" class="al-link al-pin" data-signout>Forgot it? Sign out</button>
        </div>`;
      this.pad = makePad({ onSubmit: (pin, pad) => this.submit(pin, pad) });
      el.querySelector("[data-pad]").appendChild(this.pad.el);

      // Sign out needs a second tap: it is next to the keypad.
      const out = el.querySelector("[data-signout]");
      out.addEventListener("click", () => {
        if (out.dataset.sure !== "1") {
          out.dataset.sure = "1";
          out.textContent = "Tap again to sign out";
          return;
        }
        window.cardgenAuth?.clearToken?.();
        location.reload();
      });

      // A cover that somehow outlived the page coming back: any tap settles it.
      el.addEventListener("click", () => { if (this.state === "covered") this.resume(); });
      (document.body || document.documentElement).appendChild(el);
      this.el = el;
    },

    show(mode) {
      this.build();
      this.el.dataset.mode = mode;
      this.el.hidden = false;
    },

    lock() {
      if (this.state === "locked") return;
      this.state = "locked";
      this.show("pin");
      const out = this.el.querySelector("[data-signout]");
      out.dataset.sure = "";
      out.textContent = "Forgot it? Sign out";
      this.pad.say("");
      this.pad.configure({ length: Device.read()?.len || 0 });
      const active = document.activeElement;
      if (active && active !== document.body && !this.el.contains(active)) active.blur?.();
      try { this.el.focus({ preventScroll: true }); } catch (e) { /* not focusable yet */ }
      this.refresh();
    },

    // Brings the dot count and any wait in line with the server. The lock
    // works without it: this only saves a wasted guess after the PIN's length
    // was changed on another device.
    async refresh() {
      let status;
      try {
        status = await api("");
      } catch (e) {
        return;
      }
      if (this.state !== "locked") return;
      if (!status.set) return this.gone();
      if (status.length && status.length !== this.pad.length && !this.pad.value && !this.pad.busy) {
        Device.write({ len: status.length });
        this.pad.configure({ length: status.length });
      }
      if (status.retryAfter > 0) this.pad.wait(status.retryAfter);
    },

    async submit(pin, pad) {
      const r = await checkPin(pin);
      if (r.gone) return this.gone();
      if (r.length) Device.write({ len: r.length });
      if (applyCheck(pad, r)) {
        Device.write({ len: pin.length });
        this.open();
      }
    },

    // The PIN was removed (from another device): nothing left to ask for.
    gone() {
      Device.clear();
      this.open();
      toast("The PIN was removed, so this device is no longer locked.", "info");
    },

    cover() {
      if (this.state !== "open" || !enabled()) return;
      this.state = "covered";
      this.hiddenAt = Date.now();
      this.show("cover");
    },

    resume() {
      if (this.state !== "covered") return;
      if (!enabled()) return this.open();
      const after = Number(Device.read()?.after ?? DEFAULT_AFTER) * 1000;
      const away = Date.now() - this.hiddenAt;
      if (away < 0 || away >= after) this.lock();
      else this.open();
    },

    open() {
      this.state = "open";
      if (this.el) this.el.hidden = true;
      this.pad?.configure({ length: this.pad.length });
      this.waiters.splice(0).forEach((resolve) => resolve());
    },

    whenUnlocked() {
      if (this.state === "open") return Promise.resolve();
      return new Promise((resolve) => this.waiters.push(resolve));
    },
  };

  // ── 🔒 App lock sheet ─────────────────────────────────────────────────────

  const Sheet = {
    el: null,
    pad: null,
    status: null,
    cancelAsk: null,

    async open() {
      this.close();
      const el = document.createElement("div");
      el.id = "lock-sheet";
      el.className = "pb-overlay";
      el.innerHTML = `
        <div class="pb-sheet" role="dialog" aria-modal="true" aria-label="App lock">
          <div class="pb-scroll">
            <div class="pb-head"><h2>🔒 App lock</h2><button type="button" class="ls-x" data-close aria-label="Close">✕</button></div>
            <div class="ls-main" data-main>
              <section class="pb-panel">
                <h3>This device</h3>
                <p class="ls-state" data-state>Checking…</p>
                <label class="ls-after" data-after hidden>
                  <span>Ask for the PIN</span>
                  <select data-after-select>${AFTER.map(([s, text]) => `<option value="${s}">${text}</option>`).join("")}</select>
                </label>
                <div class="pb-row" data-actions></div>
              </section>
              <section class="pb-panel" data-pin-panel hidden>
                <h3>Your PIN</h3>
                <div class="pb-row" data-pin-actions></div>
                <details class="ls-forgot">
                  <summary>Forgot the PIN?</summary>
                  <p class="pb-hint">Your account password removes it. Then set a new one.</p>
                  <form class="pb-row" data-forgot>
                    <input type="password" class="pb-input" autocomplete="current-password" placeholder="Account password" aria-label="Account password" required>
                    <button type="submit" class="btn-outline">Remove the PIN</button>
                  </form>
                </details>
              </section>
              <div class="pb-error" data-error hidden></div>
              <p class="pb-hint">Asks for a PIN before showing the app: when it is opened, and when you come back
                after being away. Anything still generating carries on behind it.</p>
              <p class="pb-hint">The PIN is for your account, so every device you turn the lock on for uses the
                same one. Each device decides for itself whether to ask.</p>
              <p class="pb-hint">Signing in with your password also gets past the lock. If that password is saved
                on this device, anyone who can unlock the device can use it.</p>
            </div>
            <section class="pb-panel ls-ask" data-ask hidden></section>
          </div>
        </div>`;
      el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-close]")) this.close(); });
      this.onKey = (e) => { if (e.key === "Escape" && Lock.state === "open") this.close(); };
      document.addEventListener("keydown", this.onKey);
      el.querySelector("[data-after-select]").addEventListener("change", (e) => {
        Device.write({ after: Number(e.target.value) });
      });
      el.querySelector("[data-forgot]").addEventListener("submit", (e) => {
        e.preventDefault();
        this.forgot(e.currentTarget);
      });
      document.body.appendChild(el);
      document.documentElement.classList.add("saw-open");
      this.el = el;
      el.querySelector("[data-close]").focus();
      await this.render();
    },

    close() {
      if (!this.el) return;
      if (this.cancelAsk) this.cancelAsk();
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
        const main = this.el?.querySelector("[data-main]");
        main?.classList.add("ls-busy"); // nothing else can be pressed while this saves
        try {
          await onClick();
        } catch (e) {
          this.error(e?.message || String(e));
        }
        if (this.el) await this.render();
        main?.classList.remove("ls-busy");
      });
      return b;
    },

    async render() {
      const el = this.el;
      if (!el) return;
      const state = el.querySelector("[data-state]");
      const actions = el.querySelector("[data-actions]");
      const after = el.querySelector("[data-after]");
      const pinPanel = el.querySelector("[data-pin-panel]");
      const pinActions = el.querySelector("[data-pin-actions]");
      try {
        this.status = await api("");
      } catch (e) {
        if (!this.el) return;
        state.textContent = `Couldn't load this: ${e.message}`;
        actions.replaceChildren(this.button("Try again", "btn-outline", () => {}));
        return;
      }
      if (!this.el) return;
      const on = enabled();
      actions.replaceChildren();
      pinActions.replaceChildren();
      pinPanel.hidden = !this.status.set;
      after.hidden = !(on && this.status.set);

      if (!this.status.set) {
        if (Device.read()?.user === currentUser()) Device.clear(); // the PIN was removed elsewhere
        state.textContent = "No PIN yet. Choose one to lock CardGen on this device.";
        actions.append(this.button("Set a PIN", "btn-primary", () => this.setPin()));
        return;
      }
      if (on) {
        state.textContent = "On for this device.";
        el.querySelector("[data-after-select]").value = String(Device.read()?.after ?? DEFAULT_AFTER);
        actions.append(
          this.button("Lock now", "btn-primary", () => { this.close(); Lock.lock(); }),
          this.button("Turn off for this device", "btn-outline", () => this.turnOff()),
        );
      } else {
        state.textContent = "Off for this device.";
        actions.append(this.button("Turn on for this device", "btn-primary", () => this.turnOn()));
      }
      pinActions.append(
        this.button("Change the PIN", "btn-outline", () => this.change()),
        this.button("Remove the PIN", "btn-outline", () => this.remove()),
      );
    },

    // Swaps the sheet for a keypad. Resolves with the PIN, or null if cancelled.
    // check(pin, pad) returns true to accept; otherwise it has told the pad why.
    ask({ title, hint = "", length = 0, check }) {
      return new Promise((resolve) => {
        const box = this.el.querySelector("[data-ask]");
        const main = this.el.querySelector("[data-main]");
        const done = (value) => {
          if (this.pad !== pad) return;
          pad.destroy();
          this.pad = null;
          this.cancelAsk = null;
          box.hidden = true;
          box.replaceChildren();
          main.hidden = false;
          resolve(value);
        };
        const pad = makePad({
          onSubmit: async (pin) => {
            if (!check || (await check(pin, pad))) done(pin);
          },
        });
        pad.configure({ length });
        const h = document.createElement("h3");
        h.textContent = title;
        const p = document.createElement("p");
        p.className = "pb-hint";
        p.textContent = hint;
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn-outline ls-cancel";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => done(null));
        box.replaceChildren(h, p, pad.el, cancel);
        this.pad = pad;
        this.cancelAsk = () => done(null);
        main.hidden = true;
        box.hidden = false;
        this.el.querySelector(".pb-scroll").scrollTop = 0;
      });
    },

    // Asks for the account's PIN and has the server check it.
    askCurrent(title) {
      return this.ask({
        title,
        length: this.status?.length || 0,
        check: async (pin, pad) => {
          const r = await checkPin(pin);
          if (r.gone) {
            pad.fail("The PIN was removed on another device. Cancel and start again.");
            return false;
          }
          return applyCheck(pad, r);
        },
      });
    },

    async chooseNew() {
      const first = await this.ask({ title: "Choose a PIN", hint: "4 to 8 digits, then OK. Six is a good length." });
      if (first === null) return null;
      return this.ask({
        title: "Enter it again",
        length: first.length,
        check: (pin, pad) => {
          if (pin === first) return true;
          pad.fail("That didn't match. Try again, or cancel to start over.");
          return false;
        },
      });
    },

    deviceOn(length) {
      Device.write({ on: true, user: currentUser(), len: length, after: Device.read()?.after ?? DEFAULT_AFTER });
    },

    async setPin() {
      const pin = await this.chooseNew();
      if (pin === null) return;
      this.status = await api("", "PUT", { pin });
      this.deviceOn(pin.length);
      toast("PIN set. This device now asks for it.", "success");
    },

    async turnOn() {
      const pin = await this.askCurrent("Enter your PIN");
      if (pin === null) return;
      this.deviceOn(pin.length);
      toast("This device now asks for your PIN.", "success");
    },

    async turnOff() {
      const pin = await this.askCurrent("Enter your PIN to turn the lock off");
      if (pin === null) return;
      Device.write({ on: false });
      toast("Lock turned off for this device.", "info");
    },

    async change() {
      const currentPin = await this.askCurrent("Enter your current PIN");
      if (currentPin === null) return;
      const pin = await this.chooseNew();
      if (pin === null) return;
      this.status = await api("", "PUT", { pin, currentPin });
      if (Device.read()?.on) Device.write({ len: pin.length });
      toast("PIN changed. Other devices ask for the new one from now on.", "success");
    },

    async remove() {
      const currentPin = await this.askCurrent("Enter your PIN to remove it");
      if (currentPin === null) return;
      this.status = await api("/remove", "POST", { currentPin });
      Device.clear();
      toast("PIN removed. No device asks for one now.", "info");
    },

    async forgot(form) {
      const input = form.querySelector("input");
      const submit = form.querySelector("button");
      this.error("");
      submit.disabled = true;
      try {
        this.status = await api("/remove", "POST", { password: input.value });
        Device.clear();
        toast("PIN removed. Set a new one to lock this device again.", "info");
      } catch (e) {
        this.error(e?.message || String(e));
      } finally {
        input.value = "";
        submit.disabled = false;
      }
      if (this.el) await this.render();
    },
  };

  // ── Page events ───────────────────────────────────────────────────────────

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      Lock.cover();
    } else {
      Lock.resume();
      pads.forEach((pad) => { if (pad.until) pad.tick(); });
    }
  });
  window.addEventListener("pagehide", () => Lock.cover());
  window.addEventListener("pageshow", () => { if (document.visibilityState === "visible") Lock.resume(); });

  // Keys go to whichever keypad is in front. While the lock screen is up
  // nothing reaches the app's own shortcuts underneath.
  const isField = (t) => !!t?.closest?.("input, textarea, select, [contenteditable]");
  window.addEventListener("keydown", (e) => {
    const shut = Lock.state !== "open";
    const pad = Lock.state === "locked" ? Lock.pad : shut ? null : Sheet.pad;
    if (shut) e.stopPropagation();
    if (!pad || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!shut && isField(e.target)) return;
    const onButton = !!e.target?.closest?.("button:not(.al-key), a, summary");
    if (/^\d$/.test(e.key)) pad.press(e.key);
    else if (e.key === "Backspace") pad.press("del");
    else if (e.key === "Enter" && !onButton) pad.press("ok");
    else return;
    e.preventDefault();
  }, true);

  // Focus stays out of the app while it is covered or locked.
  document.addEventListener("focusin", (e) => {
    if (Lock.state === "open" || !Lock.el || Lock.el.contains(e.target)) return;
    e.target.blur?.();
    if (Lock.state === "locked") {
      try { Lock.el.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }
  }, true);

  // ── Start ─────────────────────────────────────────────────────────────────

  // Called by auth.js. `fresh` is a sign-in with the password just now, which
  // counts as unlocking; otherwise it is a saved session being confirmed.
  function signedIn(fresh) {
    if (fresh || !enabled()) Lock.open();
    else Lock.lock();
  }

  function signedOut() {
    Lock.open();
  }

  function init() {
    document.getElementById("lock-btn")?.addEventListener("click", () => Sheet.open());
  }

  // Straight away, before the saved session has even been checked: the app
  // must never be seen first.
  if (enabled()) Lock.lock();

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.cardgenLock = {
    signedIn,
    signedOut,
    whenUnlocked: () => Lock.whenUnlocked(),
    lock: () => { if (enabled()) Lock.lock(); },
    isLocked: () => Lock.state === "locked",
    enabled,
    Lock,
    Sheet,
    Device,
  };
})();
