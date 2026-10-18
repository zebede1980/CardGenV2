# CardGenV2 — notes for Claude

**Current state, untested work, open issues and the next task are in `STATUS.md`.** Read it at the
start of a session and keep it up to date when you ship something.

@STATUS.md

## The iPhone is the primary client — this is a core feature, not a nice-to-have

The app is used mostly from an **iPhone (Safari)**, over HTTPS through nginx-proxy-manager, and
sometimes from a Windows desktop browser. Long AI generations (cards, lorebooks, images, chat,
story chapters) **must survive the phone locking, switching to another app, or Safari discarding
the tab**. The generation pauses while the page is asleep and must **recover on its own when the
page comes back**, without losing output and without paying for the same generation twice.

Treat any change that could break this as a regression, however small. Before shipping anything
that touches requests, streaming, timers or page lifecycle, ask: *what happens if the phone locks
halfway through this?*

### How resilience works (keep it working)

- **Resumable jobs.** Expensive calls send `resumable: true`. The proxy (`proxy/server.js`) runs the
  generation into a server-side buffer that outlives the browser connection, and keeps the result
  for 10 minutes after completion (`JOB_LIMITS.RETENTION_MS`). The browser records each job in
  `localStorage` (`src/scripts/resumable-jobs.js`) so a reloaded tab can still find it. Streams
  resume with `/api/jobs/:id/stream?from=<offset>`; non-streamed results are collected from
  `/api/jobs/:id/result`. Text and image jobs share this registry.
- **Resume loop.** `handleStreamResponse` / `_consumeStream` in `src/scripts/api.js` reconnect after
  a dropped socket. They wait with `_waitUntilVisible()` first, because nothing can reconnect while
  the page is asleep.
- **Stall watchdog.** A connection can also go silent without ever erroring or closing.
  - The proxy sends an SSE `: ping` every 15 s on text streams.
  - The client treats 45 s of silence as a dropped connection (`STREAM_STALL_MS`).
  - iOS freezes timers while locked, and an overdue timer fires the instant the page wakes. So the
    watchdog **must ignore time spent hidden or asleep**: it re-arms if the page is hidden, or if
    the timer fired late. Any new timer-based detection needs the same rule.
- **iOS cuts non-streamed requests at 60 s.** WebKit drops a `stream: false` request that gets no
  response bytes for 60 s, then silently re-sends the POST, which is a second paid call. Any call
  that may take longer than about a minute (GLM reasoning models think for a long time) **must
  stream**, so bytes keep flowing.
- **Wake lock** (`window.wakeLockManager`, used from `api.js`) keeps the screen on during
  generation where the browser allows it. It reduces locks; it doesn't replace the above.
- Never pass a third-party 401 through to the browser: `authFetch` treats any 401 as the user's
  session expiring and logs them out.

Chat, Story Writer and Adventure stream from the Python backend (`/api/sw/*`) with their own
readers in `chat-handler.js`, `storywriter.js` and `adventure-handler.js`. They are separate from
the `api.js` path above, so check them on their own when changing shared behaviour.

### Testing for it

- Check layouts at iPhone widths (320–430 px) in **WebKit**, not just Chromium. The app is
  auth-gated, so first assert that the page actually rendered, or a layout test passes on a blank
  page.
- For anything that streams or polls, simulate the lock-screen cases: page hidden
  (`visibilityState`), timers firing late after sleep, and the socket dropping while hidden then
  recovering on unlock. Not just the happy path.
- Say plainly what was tested headlessly versus on a real iPhone.

## Deploying

The dev clone is `/home/ubuntu/CardGenV2` (branch `ChatTest`). The running containers build from a
second clone. Commit and push here, then run `cd ~/DockerSource/CardGenV2 && git pull && docker
compose up -d --build`. Rebuilding the proxy restarts it, which drops in-flight jobs and wipes
`docker logs`, so check nothing is generating first. Bump the `?v=` on a script's tag in
`index.html` when changing that script.
