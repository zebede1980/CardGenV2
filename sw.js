// CardGen service worker: push notifications only (plans/ios-app.md).
//
// There is deliberately no "fetch" handler. This worker never sees, caches or
// answers a single request, so streaming, resumable jobs, the stall watchdog
// and ?v= cache-busting behave exactly as they do without it. Don't add one
// without re-running the lock-screen resilience tests.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The backend sends Apple's declarative format ({ web_push: 8030, mutable: true,
// notification: {…} }). Every browser, Safari included because the message is
// mutable, comes through here, and the notification shown is this one. That
// matters on the iPhone: a tap on Safari's own declarative notification loads
// its `navigate` URL over the open app, throwing away whatever was on screen
// and whatever the page was waiting for. A tap on this one goes to
// notificationclick below, which leaves the open page where it is. Safari only
// falls back to the declarative one if this handler fails.
function noteFrom(event) {
  try {
    const note = event.data && event.data.json().notification;
    if (note) return note;
  } catch (e) {
    if (event.data) return { body: event.data.text() };
  }
  // WebKit's event for a mutable declarative message may carry the proposed
  // notification instead of (or as well as) the raw data.
  const proposed = event.proposedNotification || event.notification;
  if (proposed) {
    return { title: proposed.title, body: proposed.body, tag: proposed.tag, lang: proposed.lang, navigate: proposed.navigate || (proposed.data && proposed.data.url) };
  }
  return {};
}

function showNote(event) {
  const note = noteFrom(event);
  const title = note.title || "CardGen";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: note.body || "",
      // Never untagged: if Safari delivers one message as both "push" and
      // "pushnotification", the second replaces the first instead of doubling it.
      tag: note.tag || `cardgen:${title}:${note.body || ""}`,
      lang: note.lang || "en-GB",
      icon: "/icons/icon-192.png",
      data: { url: note.navigate || "/" },
    })
  );
}

self.addEventListener("push", showNote);
self.addEventListener("pushnotification", showNote);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  if (url.origin !== self.location.origin) url = new URL("/", self.location.origin);
  event.waitUntil((async () => {
    // A page frozen behind the lock screen may not be listed until the tap has
    // woken it, and opening a window over it would replace it. Look a few
    // times (under a second in all) before deciding nothing is open.
    let open = null;
    for (let tries = 0; tries < 4 && !open; tries++) {
      if (tries) await sleep(250);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      open = windows.find((w) => new URL(w.url).origin === url.origin);
    }
    if (open) {
      // The app is still running: let it open the item in place rather than reloading.
      try { await open.focus(); } catch (e) { /* focus can be refused; the message still lands */ }
      open.postMessage({ type: "cardgen-open", url: url.href });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});

// The push service replaced the subscription. The worker has no login token,
// so it only renews the subscription; the page sends it to the server on its
// next start (pwa.js, Push.sync).
self.addEventListener("pushsubscriptionchange", (event) => {
  const options = event.oldSubscription && event.oldSubscription.options;
  if (!options) return;
  event.waitUntil(self.registration.pushManager.subscribe(options).catch(() => {}));
});
