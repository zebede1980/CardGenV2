# CardGenV2 as an installed iPhone app, with push notifications

Goal (Joe, 2026-11-09): CardGenV2 installed on the iPhone Home Screen as a full app: its own icon,
full screen, no Safari bars, and push notifications when something is ready or a character texts
you. The same code keeps working, unchanged, in Safari and on the PC.

This is a **Home Screen web app** (a PWA, "progressive web app": a website with a manifest and a
service worker, which iOS lets you install and which can receive push). It is not an App Store
app. A native wrapper (Capacitor) would need a Mac, an Apple developer account (£79/yr) and a
second build to maintain, and would buy little the web app can't do (see "What iOS won't let a web
app do" at the end).

## Progress

- **Stages 1 and 2 built and deployed 2026-11-09**, not yet tried on the iPhone. See STATUS.md.
  Changes from the plan below: the padding is gated on an `html.pwa` class set from
  `display-mode: standalone` (same effect, but tests can force it); the VAPID key is generated
  and stored in `app_secrets` rather than set in `.env`; the internal push route for the proxy
  moves to Stage 3, which is the first thing that needs it. Joe tried Stages 1–2 on the iPhone
  2026-11-10: "all looks good so far".
- **Stage 3 built and deployed 2026-11-10.** Changes from the plan below:
  - "Nobody is watching" means **the page that started it is hidden**. Each page load has a random
    id (`X-Page-Id` on every request) and reports hidden/shown (`POST /push/presence`, a keepalive
    fetch). A reader still attached doesn't count: a locked iPhone can keep its socket open, and the
    proxy's `/api/sw/*` forwarder never tells the backend that the browser went away.
  - Lock-screen privacy is **one setting for all kinds**, not one per kind (default Name only).
  - Proxy jobs from one page are reported **once, when the last of them finishes** (Generate 4,
    Compare Models).
  - Not built: clearing a notification when you open the item some other way; recovering a card or
    picture after iOS closed the app (the page that would collect it is gone).

## Where the code stood before (2026-11-09)

- `index.html` already has `viewport-fit=cover`; `main.css` uses `env(safe-area-inset-*)` in 32
  places (8 for the top). No manifest, no `apple-touch-icon`, no `apple-mobile-web-app-*` tags, no
  `theme-color`, no service worker.
- Login is a 30-day JWT in `localStorage` (`cardgen_auth_token`). Settings sync to the server
  (`/api/config`), so an installed app gets them back after logging in. Per-device things (theme,
  Aa sizes, a key kept "on this device only") don't come across.
- There is no URL routing: every page is a view switched in script, so there's nothing a
  notification could link to yet.
- nginx (`.docker/nginx/nginx-frontend.conf`): `index.html` and `.js` are `no-cache`; `/src/` CSS and
  images are `immutable` for a year and rely on `?v=`. `Dockerfile.frontend` copies only `src/`,
  `index.html` and `favicon.png`.
- The proxy's jobs (`generationJobs` in `proxy/server.js`) track their readers (`subscribers`,
  `listeners`) and keep a result for 10 minutes after it finishes (`JOB_LIMITS.RETENTION_MS`).
- Messenger check-ins are run by the browser: on opening a chat it asks `checkin-due` and
  generates one then (`messenger-handler.js` ~491). Nothing happens while the app is closed.

## Stage 1: install properly (frontend only, no new dependencies)

What you get: a proper icon and name, full screen, a status bar that matches the theme, and a way
to pick up a new version.

1. **`manifest.webmanifest`** at the site root: `name`, `short_name` ("CardGen"), `start_url: "/"`,
   `scope: "/"`, `display: "standalone"`, `background_color` and `theme_color` matching the dark
   theme, and icons at 192 and 512 px (plus a 512 `maskable` one).
2. **Icons:** a 180 px `apple-touch-icon.png` (iOS ignores manifest icons for the Home Screen
   tile) and the manifest sizes. Joe to choose the artwork; `favicon.png` is the starting point.
3. **`<head>` tags:** `<link rel="manifest">`, `<link rel="apple-touch-icon">`,
   `apple-mobile-web-app-capable`, `apple-mobile-web-app-title`,
   `apple-mobile-web-app-status-bar-style: black-translucent`, and a `theme-color` meta that the
   theme toggle (`config.js` ~1040) updates when it switches light/dark.
4. **Top safe area:** with `black-translucent` the page runs under the status bar and the clock.
   Add top padding (`env(safe-area-inset-top)`) to the app header and to every sticky or fixed
   top bar: Story Writer reader, Adventure, Messenger, Roleplay Chat's shell, the full-screen
   sheets (Prompt Builder, edit sheets, New story/adventure) and the lightbox close button. Put all
   of it under `@media (display-mode: standalone)` so Safari and the PC are untouched.
5. **`standalone` class on `<html>`** from `matchMedia('(display-mode: standalone)')` (plus
   `navigator.standalone` for older iOS), for any script that needs to know.
6. **"New version" prompt:** an installed app has no reload button or pull-to-refresh, and iOS
   keeps it in memory for days, so a deploy isn't seen until the app is killed. Put the build id
   in a `version.json` (written at image build time). On wake, fetch it; if it changed, and nothing
   is generating, show a toast: "Update ready: tap to reload". Useful in a browser tab too.
7. **`Dockerfile.frontend`:** copy the manifest, icons and `version.json`. nginx needs a MIME type
   for `.webmanifest` (`application/manifest+json`).
8. **Check in the installed app on the iPhone:** card PNG and JSON exports (blob downloads have
   been unreliable in iOS Home Screen apps; if they fail, Stage 5's share sheet fixes it), links
   that open new tabs (`window.open` in Story Writer and card viewer), the photo picker, the keyboard
   with the fixed chat shells, the wake lock (Apple fixed it for Home Screen apps in iOS 18.4, I
   believe), and logging in.

**Testing:** headless WebKit can't run as an installed app. Force the `standalone` class with a
test-only query flag and stand in a 47 px top inset to check every top bar at 320/390/430 px light
and dark, and check that nothing moves without the flag. Then add it to the real iPhone's Home Screen.

## Stage 2: push plumbing (one new Python dependency)

What you get: Settings → 🔔 Notifications with **Enable on this device** and **Send a test**. Tapping
the test opens the app on the right page.

How Web Push works: the browser gives us a *subscription* (an endpoint URL at Apple's, Google's or
Mozilla's push service plus keys). To notify, our server encrypts a small message with those keys
and posts it to the endpoint, signed with our VAPID key (a key pair that proves the pushes come
from us). The push service can't read the content. The phone wakes our service worker, which shows
the notification.

1. **iOS rules:** iOS 16.4 or later, **only once the app is on the Home Screen**, permission asked
   from a tap (never on load), and every push must show a notification (iOS revokes the
   subscription of a site that sends silent ones). Desktop Chrome, Edge and Firefox support push
   without installing, so the PC can get notifications too.
2. **`sw.js` at the root**, registered at `/`: `push` → `showNotification`; `notificationclick` →
   focus an open window and navigate it, or open a new one at the notification's URL;
   `pushsubscriptionchange` → re-subscribe. **It has no `fetch` handler**, so it never sees or caches
   a single request (see "Will any of this break the browser?" below).
3. **Declarative Web Push** (Safari 18.4+): send the payload in Apple's declarative JSON form
   (title, body, URL, badge in the payload itself), so iOS can show it even if the service worker
   is slow to start. Older browsers get the same data through the `push` handler. Check the exact
   format at build time.
4. **Backend owns push** (Postgres is there already, and most notifications start there):
   - Table `push_subscriptions` (user id, endpoint, keys, device label, user agent, created,
     last used). Endpoints that answer 404/410 are deleted.
   - Routes `POST /api/sw/push/subscribe`, `DELETE …/subscribe`, `POST …/test`, and
     `GET/PUT …/prefs` for which kinds of notification to send.
   - **`pywebpush`** (new dependency) does the encryption and VAPID signing.
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:`) in the backend's env;
     the public key is served to the browser.
   - An internal `POST /internal/push` guarded by `INTERNAL_API_SECRET`, so the proxy can ask for
     a push without a dependency of its own.
5. **Deep links:** notifications need somewhere to land. At boot, read
   `?open=messenger&chat=<id>` (also `chat`, `story`, `adventure`, `playground`, `character`), open
   that view and item, then `history.replaceState` the query away. This is only "read a link on
   start". Back-button history is Stage 5.

**Testing:** backend tests with a fake push endpoint (subscribe, send, 410 drops the row, prefs);
the service worker's `notificationclick` in headless Chromium with a fake push. A real push to the
iPhone can only be tested on the iPhone.

## Stage 3: tell me when it's done

What you get: lock the phone during a long generation; a notification says it's finished; tap it
and the result is there, not paid for twice.

1. **Only when nobody is watching.** Send a push only if no client is reading the result when it
   finishes: in the proxy, a job with no live stream reader or waiting request; in the backend, a
   generation whose SSE client went away. A tab that is open and watching gets no push.
2. **What notifies** (each switchable in prefs):
   - Proxy jobs: character card, lorebook, image / edit / Reimagine, Compare Models (one push for
     the set, not one per model).
   - Backend: Roleplay Chat reply, Messenger reply, Adventure beat, Story Writer chapter.
     ✨ Auto-written story finished, or stopped with an error.
   - Failures too: "Card failed: <reason>", so you don't come back to nothing.
3. **Keep the result long enough to be collected.** Today a proxy job's result is dropped 10
   minutes after it finishes, so tapping a notification an hour later would find nothing (the same
   thing already happens if the phone stays locked that long). Keep a job that sent a push for
   longer (e.g. 24 h, under a total memory cap), or keep its finished text in the backend. Backend
   generations are already saved in Postgres.
4. **Tapping it** opens the deep link. The existing paths then do the rest: `resumable-jobs.js`
   finds the job in `localStorage` and collects it, and chat views reload their messages.
5. **Lock-screen privacy.** A notification's text shows on the lock screen and in Notification
   Centre, and chat content is often adult. A setting per kind: **Show preview** / **Name only**
   ("Mira sent you a message") / **Nothing** ("CardGen: something's ready"). Default: name only for
   Messenger and Chat.
6. **`tag`** per chat or job, so a new push replaces the old one instead of stacking.

**Testing:** headless runs of each kind with the page hidden and the socket dropped: one push, no
push while watching, tap → result collected without a second request. Then on the iPhone: lock
mid-card, mid-Messenger reply, mid-auto-story.

## Stage 4: Messenger characters text you first

What you get: with "Check in" on, Mira texts you after a day of quiet, and it buzzes in your pocket.

1. **A scheduler in the backend** (an asyncio loop in the uvicorn process, as auto-writing runs),
   every 10 minutes: find Messenger chats with check-in on and one due (`_checkin_due`), generate the
   check-in on the server with the same prompt the browser path uses, save it, push it ("Mira: hey,
   you alive?") and set the badge.
2. **Separate opt-in, because it spends money while you're away:** "Text me first" per chat, apart
   from today's "check in when I open the chat". Guards: at most N a day per chat and in total,
   quiet hours (default 23:00–08:00, UK time), back-off when you don't reply (a second check-in
   only after you've answered the first), and a global off switch.
3. **The browser path stays** for people without push: if a server check-in already ran, `checkin-due`
   says no, so it's never generated twice.
4. **Unread count:** a chat's unread messages → `navigator.setAppBadge(n)` on the Home Screen icon,
   set by the service worker on push and by the page on reading. Lobby rows get an unread dot.
5. Later, if wanted: the character "replies later" when you text it and close the app straight
   away (the reply already runs on the server; this just pushes it).

**Testing:** backend tests for the scheduler with a fake clock and a fake model (due/not due,
quiet hours, daily cap, back-off, no double check-in with the browser path). Then a week of real use.

## Stage 5: feeling like an app (each piece optional and separate)

1. **Back navigation:** an installed app has no Back button, and the PC browser's Back leaves the
   app entirely. Push a history entry for each view and opened item (the Stage 2 deep links), so
   Back, and the iOS edge-swipe where it works, go back a screen. **This changes the PC's Back button**,
   for the better, but it's the one change here that touches every view, so it gets its own WebKit
   run across all views.
2. **Share sheet for exports:** `navigator.share({ files })` for card PNGs, JSON, lorebooks and
   images: Save to Photos, Files, AirDrop. It falls back to today's download where `canShare` says
   no (the PC). This fixes Stage 1's download problem if it has one, and is better in Safari too.
3. **Lock-screen controls for narration:** the Media Session API on Story Writer's narration audio
   (title, play/pause, skip passage) shows controls on the lock screen. Check whether narration
   keeps playing when an installed app is locked. Historically iOS was worse at this for Home
   Screen apps than for Safari.
4. **`navigator.storage.persist()`** and a note in Settings. Safari can clear a site's
   `localStorage` after 7 days without a visit; Home Screen apps are exempt, so the token, resumable
   jobs and photo-job refs last longer. Persisting asks the browser to keep them anyway.
5. **Login lifetime:** the 30-day JWT means logging in again each month on each device. Consider
   renewing it silently on use (sliding expiry) so an app opened weekly never logs out.
6. **Launch screen:** `background_color` gives a plain screen in the theme colour on start instead
   of white. Proper `apple-touch-startup-image` splash images need one per screen size; not worth it.
7. **Camera:** Messenger's 📷 Photo could offer "Take photo" (`capture`) as well as the library.

## Will any of this break the browser on the PC or the iPhone?

No, if it's built as above. Each change against what it does outside the installed app:

| Change | PC browser | iPhone Safari | Risk |
|---|---|---|---|
| Manifest, icons, `apple-*` metas, `theme-color` | Chrome/Edge show an "Install" button; nothing else | Ignored until added to the Home Screen; `theme-color` tints Safari's bar | None |
| Top safe-area padding | None (under `display-mode: standalone`) | None | None if kept under that media query. Ungated, it would add a strip in Safari landscape or a future Safari layout |
| Update prompt | Shows after a deploy; tap to reload | Same | Low: must not offer while something is generating, or a reload would cut it (resume would recover it, but don't rely on that) |
| **Service worker** | Registered; does nothing until push is on | Same | **The only one that could do real harm**, and only if it had a `fetch` handler: a caching worker can serve a stale `index.html` (defeating `?v=`) or sit between the app and its streams (resumable jobs, SSE resume, the stall watchdog). With **no `fetch` handler** it never sees a request. Never add one without re-running the resilience tests |
| Push subscribe / prefs | Works on the PC (bonus) | The button says "Add CardGen to your Home Screen first" | None |
| "Only when nobody's watching" pushes | An open tab gets no pushes for what it shows | Same | Low: a bug here means an extra or a missing notification, not a broken page |
| Longer job retention | More proxy memory | — | Low, with a memory cap |
| Deep links at boot (`?open=`) | New, harmless | Same | Low: a bad id must fall back to Home, not a blank view |
| Server-side check-ins | A character may have texted while you were away; you see it on opening | Same | No breakage, but **paid calls without you opening the app**. Separate opt-in, capped |
| History entries for Back (Stage 5) | Back moves between screens instead of leaving the site | Same, plus swipe-back | **Behaviour change** to every view; the one piece most likely to cause bugs (e.g. Story reader's release rule). Its own stage and test pass |
| Share sheet for exports | Unchanged (falls back to download) | Share sheet instead of the download preview | None |
| Media Session | Media keys and the OS media overlay show the narration | Lock-screen controls | None |

Two differences that are not breakage, but you'll notice them:

- **The installed app and Safari don't share storage.** Log in once more in the app. A generation
  started in Safari isn't picked up by the app, and the other way round. Push subscriptions are per
  install, so you enable notifications in the app itself.
- **An installed app still freezes when locked.** Being installed doesn't let JavaScript run in the
  background; generation still runs on the server and resumes on wake as now. Push is what tells
  you it's done.

## What iOS won't let a web app do (so don't plan for it)

No background running or background sync, no silent pushes, no vibration or haptics, no Share
Target (appearing in other apps' share sheets), no manifest `shortcuts` (long-press menu on the
icon), no widgets, no Siri, no install button (only Share → Add to Home Screen). If any of these
becomes a must-have, that's the point to reconsider a Capacitor wrapper.

## Order and deploys

1. Stage 1: frontend rebuild only.
2. Stage 2: frontend + storywriterbackend rebuild (new table, `pywebpush`, VAPID keys in `.env`).
3. Stage 3: proxy rebuild too (internal push call, retention), which drops in-flight jobs: deploy when idle.
4. Stage 4: storywriterbackend.
5. Stage 5: any order.

Ship Stage 1 on its own and live with it on the phone for a day or two first: Stage 2 can't be
tested end to end until the app is installed, and any layout problems under the status bar show up
there.
