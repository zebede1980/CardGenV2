// CardGen service worker: push notifications only (plans/ios-app.md).
//
// There is deliberately no "fetch" handler. This worker never sees, caches or
// answers a single request, so streaming, resumable jobs, the stall watchdog
// and ?v= cache-busting behave exactly as they do without it. Don't add one
// without re-running the lock-screen resilience tests.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The backend sends Apple's declarative format ({ web_push: 8030, notification: {…} });
// Safari 18.4+ can show that by itself, every other browser comes through here.
self.addEventListener("push", (event) => {
  let note = {};
  try {
    note = (event.data && event.data.json().notification) || {};
  } catch (e) {
    note = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(note.title || "CardGen", {
      body: note.body || "",
      tag: note.tag || undefined,
      lang: note.lang || "en-GB",
      icon: "/icons/icon-192.png",
      data: { url: note.navigate || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  if (url.origin !== self.location.origin) url = new URL("/", self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === url.origin);
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
