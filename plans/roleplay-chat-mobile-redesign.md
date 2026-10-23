# Roleplay Chat on the iPhone: review and redesign plan

Written 2026-10-23. Joe's brief: the in-chat "full screen" view is glitchy on the iPhone; improve it
for the iPhone without hurting desktop; nothing off the table.

## How it was reviewed

- Read the chat layout code: `chat-handler.js`, the chat sections of `main.css`, the markup in
  `index.html`.
- Rendered the real page in WebKit at 390×844 and 1280×800 with every `/api` call stubbed (rig:
  a static server for the dev copy plus `page.route`; 6 user + 6 long AI messages, 2 characters).
- **Not reproducible headlessly:** anything involving the iPhone keyboard. Findings 3 and 9 come
  from the code plus known iOS Safari behaviour; confirm them on the phone.

## What's there now

1. **Two full-screen systems, one of them dead.** `#view-roleplaychat.chat-fullscreen`, with
   `toggleFullscreen()` and references to a sidebar, was orphaned by `bb39a1e` (lobby redesign):
   its button no longer exists and nothing calls it. About 500 lines of mobile CSS (capsule
   composer, round icon buttons, 16 px inputs, safe-area header) therefore never apply. What runs
   is `body.chat-in-chat` (fixed, `100dvh`, z-index 500), stacked on the base rules, the 768 px
   rules, `body.chat-active` and `body.chat-active:not(.chat-in-chat)`. That's five layers, with a
   lot of `!important`.
2. **iOS zooms the page when you tap the message box.** Measured: the message box is 15 px, the
   OOC note 14.4 px. Safari zooms in on any field under 16 px and doesn't zoom back out, so the
   fixed chat is left partly off-screen until you pinch out. This is probably most of the
   "glitchy" feel.
3. **The keyboard isn't handled.** The view is `position: fixed` + `100dvh`. iOS doesn't shrink
   the page when the keyboard opens; it pans the visible area instead. So the header slides off
   the top, the page can be dragged about, and closing the keyboard can leave the view offset.
   Nothing listens to `visualViewport`.
4. **The composer takes up 159 px of an 844 px screen (19%) in three rows:** the text box, then
   🎭 OOC / speaker "Auto (Ro…" / Send, then Impersonate on its own row. The placeholder mentions
   Shift+Enter, which an iPhone doesn't have, and Return sends, so there's no way to type a
   newline.
5. **Header:** the title is cut to "Neon …" by A-/A/A+ and the "⚙️ Settings" label.
6. **Every message shows Gen Image / Edit / 🗑 / Regen all the time** on touch (12 of 12 in the
   test).
7. **The ↓ jump button** is fixed at `bottom: 80px`, but the composer is 159 px tall, so it sits on
   top of the composer (visible in the screenshot).
8. **The avatar column** (36 px plus gap) on every message narrows the text on a phone.
9. **Editing:** the textarea is at least 250 px tall inside the bubble. Under 480 px the Save/Cancel
   bar becomes `position: fixed; top: 0`, which is exactly what iOS's keyboard panning scrolls
   out of view.
10. **Waking aborts healthy replies.** `syncOnWake` runs on `visibilitychange` *and* window
    `focus`. If a reply is streaming, it aborts the stream and reloads the whole chat. So
    switching apps (or, on desktop, windows) mid-reply kills a working stream and redraws the
    chat with a jump. Both events fire, so it can reload twice. There's no stall watchdog either
    (already a known open issue).
11. **Desktop:** bubbles run the full width, about 150 characters per line, which is hard to read.
12. **Lobby on the phone:** the app header and six tab buttons take about 420 px before the first
    chat card.

## Recommendation: rebuild the chat screen's layout, keep its logic

Rewrite the layout (the active view's markup, one consolidated CSS section, and a small viewport
helper), and delete the dead full-screen code. Keep `chat-handler.js`'s data, streaming and
editing logic, with targeted fixes.

### Target design: iPhone first, desktop the same structure

- **Shell:** one fixed layer sized to the **visible** viewport. `--chat-vh` / `--chat-vtop` are set
  from `visualViewport` resize and scroll events. `html`/`body` are locked (no overflow,
  `overscroll-behavior: none`) only while in a chat. When the keyboard opens, the shell shrinks
  to the space above it: the header stays put and the composer sits on the keyboard.
- **Header (about 48 px + safe area):** ‹ back · avatar(s), title and characters (tap opens the
  character cards) · ⋯ menu (text size, character cards, chat settings, persona). On desktop the
  same items sit inline.
- **Timeline:**
  - Phone: no avatar column; a small avatar sits in the name row and the text uses the full width.
  - Desktop: a reading column of about 760 px, centred, with avatars kept.
  - User messages: accent-coloured bubbles on the right.
- **Message actions:** hidden until you tap a message; tapping elsewhere hides them. The latest AI
  message always shows ↻ Regen. On desktop they appear on hover.
- **Composer (about 56 px):** `[＋] [text box, 16 px, grows to about 5 lines] [Send ⇄ Stop]`.
  - ＋ opens a tray: OOC note, Impersonate, Speaker (group chats), Scene image.
  - An active OOC note and the chosen speaker show as removable chips above the box.
  - Return types a newline on touch devices and the Send button sends. On desktop, Enter still
    sends.
- **↓ button:** anchored to the top of the composer, with a dot when new text arrives below.
- **Streaming:** on send, scroll so the reply's first line is in view, then stop following, so
  you read from the top while it writes. The ↓ button catches up.
- **Editing:** a full-screen sheet like the Prompt Builder's, sized to the visible viewport.
  Cancel / Save are in its header, so the keyboard can never hide them. The textarea fills the
  rest, and Insert `</think>` lives in the sheet.
- **Waking:** drop the `focus` trigger. On `visibilitychange`, leave a live stream alone. Only
  when it's dead or stalled (a 45 s watchdog that ignores time hidden, per CLAUDE.md) poll the
  server for the finished message, then update that one bubble instead of redrawing the chat.

### Optional: Home Screen app mode

iPhone Safari can't put a page truly full screen (no Fullscreen API for pages on iPhone), so the
toolbar always takes space. "Add to Home Screen" with a manifest (`display: standalone`),
`apple-mobile-web-app-capable` and a status-bar style gives real full screen for the whole app.
Costs:
- The Home Screen app has its own storage, so you log in once there.
- External links open in a Safari sheet.
- The shell must pad for the notch (`safe-area-inset-top`).

## Phases

1. **Quick wins** (small, ships on its own, likely fixes most of the glitchiness): 16 px fields;
   stop wake/focus from aborting a live stream; ↓ button above the composer; text size into a ⋯
   menu; Return = newline on touch; desktop reading width.
2. **Shell rebuild:** the visual-viewport shell, the new header and composer with tray. Delete
   the dead code (`.chat-fullscreen` CSS, `toggleFullscreen`, sidebar references, the injected
   `#chat-touch-fixes` style) and merge the chat CSS into one section.
3. **Messages:** the phone layout without the avatar column, tap-to-show actions, the edit sheet,
   the streaming scroll behaviour.
4. **Resilience:** a chat stream stall watchdog plus a poll for the finished message, proven with
   lock-screen simulation (hidden page, late timers, socket dropped while hidden).
5. **Optional:** Home Screen app mode.

## Testing

- The WebKit rig at 320/375/390/430 and 1280, light and dark, with before/after screenshots. Assert
  the chat actually rendered (non-zero timeline height) before trusting any measurement.
- Keyboard: headless WebKit has no iOS keyboard. Test the shell by shrinking `visualViewport`
  (resize the viewport mid-test) and checking the header and composer stay in view. Then check on
  the iPhone: keyboard open/close, rotation, locking mid-reply, editing a long message.
- Real GLM chat calls are fine for streaming checks (Joe, 2026-10-23).

## Decisions for Joe

1. Return key on the iPhone: newline (recommended) or send?
2. Avatars on the phone: in the name row (recommended) or keep the left column?
3. Home Screen app mode: in scope?
4. Ship Phase 1 first, or go straight to the rebuild?
