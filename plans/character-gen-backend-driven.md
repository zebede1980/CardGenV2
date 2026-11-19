# Character Gen: making it backend-driven

Written 2026-11-19 from a read of the code at `4e98809`. **Phases 0 to 2 are built** (same day,
not deployed): see "What was built" straight below, which also says where the build departed from
this plan. The rest of the document is the plan as written.

## What was built (2026-11-19), and where it departs from the plan

| Phase | State |
|---|---|
| 0 | Done. On for everyone |
| 1 | Done, and much smaller than planned (below) |
| 2 | Done, behind Settings → "Make new characters on the server (beta)", off by default |
| 3 | First slice done: the new card's portrait is drawn by the run. Regenerate, Gen 4, Compare, takes, Edit and the gallery are not started |
| 4 | One piece done: 4 ideas and Inspire Me use a run once an idea is picked. The rest is not started |
| 5 | Not started |

**Phase 1 was not a rewrite.** The plan expected to move every prompt builder into `src/shared/`
modules that take a settings object, with golden tests guarding thousands of moved lines. A probe
showed the browser's prompt files already load and run in a bare Node sandbox without touching the
page. So the proxy loads those same files (`proxy/runs/prompt-host.js`) and supplies a server-side
`APIHandler` for them to extend. Nothing was moved and there is still one copy of every prompt. The
"golden test" became a direct comparison: the same inputs through the real page and through the
proxy's host must produce the same requests, and do, for all four card kinds and for the portrait.
The price is that ten front-end files (`SHARED_SCRIPTS`) now also run on the server and must stay
free of page access on the paths a run uses.

**Decisions taken as recommended:** the proxy conducts (1); run state is a file per run on the
proxy's disk (5); progress is polled every 1.5 s (4); Stop keeps the card in History as a draft (3).
Decision 2, how far to go, is still open.

**The working-card id is simply the History item.** Phase 2 did not need a new kind of record:
`replaceHistoryId` lets a save update a History item in place, and that id is what a run, the
page's last save and the recovery code all refer to.

**Settings travel with the request.** The page sends its settings object when it starts a run, so
the run uses exactly what the page would have, including a change made a second earlier. Only a
Resume with no page settings falls back to the saved copy.

**Still the page's job:** saving the prompt to the library (the 41 MB download is untouched),
supporting cast, the brainstorm call of 4 ideas and Inspire Me, and every action on a card that
already exists.

**Why it stopped where it did.** What is left all acts on an existing card. The engine can run those
steps today; what is undecided is the page side: where a Redo's result goes if you have typed in
other fields since, how Gen 4's candidates are shown when they were drawn while you were away, and
whether Reset keeps working. Those are choices for Joe, best made after using phases 0 to 3 on the
phone.

**Things found on the way and fixed:** History saves and deletes could wipe the whole list after
one failed read; a second tab cleared the first tab's recovery marker; a stopped pipeline's cleanup
reset the form of the next generation; the image routes sent an internal field to the provider.

## The short version

- Today the **browser is the conductor**. Pressing Generate starts a chain of 5 to 12 requests, and
  the page's JavaScript decides when each one starts. The server only ever sees one request at a time.
- Each request on its own survives a locked phone (resumable jobs). **The chain doesn't.** A locked
  phone finishes the step it was on and then waits for you. A tab that Safari discards loses the lot:
  nothing reads the pending jobs back on reload, and the card is only saved at the very end.
- The fix is to move the conductor to the server: the browser posts *what you asked for*, the server
  runs every step, saves the card itself, and sends one push when it is all done. The page becomes a
  viewer that can be closed, reopened, or opened on another device.
- **Recommended home: the Node proxy**, not the Python backend. The prompt code and the whole image
  pipeline are already JavaScript; porting them to Python would be a 5,000-line rewrite with two
  copies to keep in step.
- **The expensive part isn't the server loop.** It is that every prompt is built by browser code
  (`api-character.js`, `api-image.js`, `prompt-look.js`, the name bank) that reads settings off the
  page. That code has to become loadable by the server first.
- Not every button needs this. The multi-step pipelines do. Single-call buttons (Redo a field, tags)
  only need to be made resumable, which is a small job that can ship first.

## What happens today

### One new card, step by step (`handleGenerate`, `main.js:1183`)

| # | Step | Where it runs | Call | Resumable? |
|---|---|---|---|---|
| 1 | Save the prompt to the library | browser | downloads **every** saved prompt to look for a duplicate (41 MB on 2026-11-13) | no |
| 2 | Web search (search mode only) | proxy | `/api/search/character` | no |
| 3 | Write the card | text model | stream, 16k tokens | yes |
| 4 | Parse it, pull the name, force `{{char}}` | browser | `character-generator.js` | n/a |
| 5 | Example messages + creator's notes + post-history | text model | one stream | yes |
| 6 | Any of those three missing: one call each | text model | notes and post-history are non-streamed | **no** |
| 7 | Supporting cast, if ticked: suggest, then one call per member, then inject keys | text model | several | yes |
| 8 | Write the portrait prompt | text model | stream | yes |
| 9 | Draw the portrait | image model | job | yes |
| 10 | PC off: draw again on the hosted fallback | image model | job | yes |
| 11 | Fetch the image, convert it, upload card + image to History | browser | `saveCardToLibrary` | n/a |

Between every pair of rows is page JavaScript. That is the weakness.

### What a lock or a discard does to it

- **Phone locks during step 3.** The proxy finishes the card. iOS has frozen the page, so steps 4 to
  11 don't start. Unlock five minutes later and the card text appears, then the app spends another
  minute or two on the rest while you hold the phone awake.
- **The "done" push is early.** The proxy pushes when a page's last *job* finishes. After step 3
  there is no other job running, so with the page hidden you get "Character card" while steps 4 to 11
  haven't begun. (From reading `onJobFinished`; not observed on the phone.)
- **Safari discards the tab at any point before step 11.** `currentCharacter`, the pipeline position
  and the image all live in page memory. The pending jobs are still listed in `localStorage`, but no
  code collects them on reload. STATUS already says this: "If iOS closed the app, the result is lost."
  You paid for the card and have nothing.
- **Stop between steps** only works because each step checks a mark. Closing the tab is the only
  other way to stop, and it works by accident.

### Every Character Gen function, sorted by how it should be treated

**A. Pipelines the page conducts (the real problem):**

| Action | Chain |
|---|---|
| ✨ Generate, classic and search | the table above |
| 💡 Inspire Me | ideas (non-streamed, not resumable) → you pick → the same chain |
| 🎲 4 ideas | ideas (non-streamed, not resumable) → you pick → the same chain |
| Revise, Remaster, Reduce tokens, Consistency auto-fix | rewrite the card (16k stream, **not resumable**) → step 5 → step 6 |
| Supporting cast, lorebook generation | suggest → one call per entry → inject |
| Portrait: Regenerate, Gen 4, Compare Models, Generate all 3 takes | write prompt → 1 to 4 image jobs → pick |

**B. Single calls (one request, result lands in one field):**

| Action | Today |
|---|---|
| Redo description / personality / scenario / first message | stream, not resumable |
| Example messages | stream, not resumable |
| Redo creator's notes, post-history; tags | non-streamed, not resumable |
| Name picker | non-streamed (often served from the name bank with no call) |
| Alt greeting | stream, not resumable |
| Consistency check | stream, not resumable |
| Describe a reference image, match an image's style | non-streamed vision calls |
| Draft image prompt, lorebook entry writers | already resumable |

**C. Browser-only, and should stay that way:** typing in the fields, Download PNG (the card is
encoded on a canvas), cropping, uploading an image, Clear / New, the review queue, the library views,
backup and restore of settings. SillyTavern push and URL import already run in the proxy.

## Target design

### A "card run" on the server

A *run* is one pressed button, executed start to finish by the proxy.

1. The browser posts a **spec**: mode, concept, name, POV, card type, lorebook, reference image,
   example count, cast tickbox, the active Look, and an **idempotency key** (a random id made before
   the request, so a double tap or iOS re-sending the POST can't start two paid runs).
2. The proxy copies the user's saved settings into the run (model, keys, image model, style), so a
   settings change on another device mid-run can't alter it.
3. It runs the steps in order. After **each** step it writes the run record: status, current step,
   each finished step's output, a log line, token usage.
4. The card is saved to History **as soon as the text is parsed**, and updated as later steps finish.
   A failure in the portrait no longer costs you the card.
5. When the run ends it sends **one** push ("Mira Okafor is ready", or what failed).
6. The page polls `GET /api/card-runs/:id?from=<chars>` every 2 s while visible and never while
   hidden. This is the pattern auto-written stories already use, and it needs no watchdog, no resume
   loop and no wake lock. On load, `GET /api/card-runs?active=1` finds a run in progress and attaches
   to it, on any device.
7. `POST …/stop` aborts the upstream call in flight and ends the run. `POST …/resume` restarts an
   interrupted run from its first unfinished step.

### Where it lives: the proxy

| | Node proxy | Python backend |
|---|---|---|
| Prompt builders | reuse the existing JS | rewrite ~3,400 lines, keep two copies in step |
| Image pipeline (ComfyUI graphs, catalogue sizes, fallback) | already there | rewrite, or call back into the proxy |
| Card and image storage | already there | already reachable |
| Jobs, cancel, push reporting | already there | separate system |
| Durable state | none today (memory only) | Postgres |

The Python backend wins only on durable state, and that is the cheap part to add.

**Run state:** one JSON file per run under `proxy/data/users/<id>/runs/`, written with a
temp-file-and-rename so a crash can't leave half a file. On start the proxy marks any run still
"running" as "interrupted". I prefer this to Postgres here because the proxy can only reach Postgres
through the Python container, which is rebuilt often; a run shouldn't stall because chat was deployed.
Finished runs are deleted after a day; the card itself is in History.

### The work that makes it possible: shared prompt modules

The server can't build a card prompt today. The builders are methods on the browser's `APIHandler`
that call `this.config.get(…)` 54 times across three files and read two things from `localStorage`.

A **shared module** is one file that both the browser (`<script>` tag) and Node (`require`) can
load: it touches no page, takes its settings as an argument, and returns text. The plan:

- New folder `src/shared/` for: card prompts (single, group, scenario, search), finishing fields,
  the parser, the image-prompt writer and Looks, the name bank, the content-context line.
- Each builder takes a plain `settings` object instead of reaching for `this.config`.
- The browser's existing methods become one-line wrappers, so nothing else in the page changes.
- `Dockerfile.proxy` copies `src/shared/` (today it copies `server.js` alone).
- The run engine goes in new files (`proxy/runs/…`), not into the 5,354-line `server.js`.

**Golden tests** guard the move: before touching anything, record the exact prompts the current
code produces for a dozen fixed inputs; afterwards the shared modules must produce the same bytes
from Node. That turns a risky refactor into a mechanical one.

## Follow-up actions on a card you already have (added 2026-11-19, second pass over the tab)

Joe asked whether later images, AI revisions and single-field Redo are covered. The first draft
covered them unevenly: revisions had a phase, later images were listed but had no phase, and Redo
was only made resumable. The reason they are harder than Generate is the same for all three:

**The server has nowhere to put the result.** A new card can simply be saved to History. A Redo or
a second portrait has to land on *the card you are working on*, and that card has no identity on the
server: it is `currentCharacter` in page memory, and every History save writes a new snapshot
(`h_<time>`), not an update. So a result that arrives after the page has gone has no address.

**The fix is a working-card id, and it belongs in phase 2, not phase 5.** The first run creates a
working card with a stable id; every later run names that id and a target ("field: scenario",
"portrait", "gallery"), and the server writes the result there. Phase 5 shrinks to the part that
is really optional: saving what you *type* as you type it.

| Action | Today | After phase 0 | Fully server-run in |
|---|---|---|---|
| Redo a field, example messages, notes, post-history, tags, alt greeting, name | one call into page memory; most not resumable | survives a lock; still lost if the tab is discarded | 4 (one-step run → card X, field Y) |
| Revise, Reduce tokens, Consistency auto-fix, Remaster | rewrite + finishing fields, conducted by the page; rewrite not resumable | rewrite survives a lock; the chain still stalls | 4 |
| Import & Remaster, review queue | queue of imported cards kept in `localStorage` with their images; each remastered by the page | no change | 4 (queue on the server) |
| Regenerate portrait, Draft prompt + Generate | prompt write + image job; both resumable; result into page memory | no change needed for locks | 3 |
| Gen 4, Compare Models, Generate all 3 takes | up to 4 jobs, then a pick-one dialog that only exists in the page | no change | 3 (results kept on the card as candidates; you pick when you're back) |
| ✨ Edit portrait | caption call (Klein, H3) → edit job; resumable; result into page memory | no change | 3 |
| Gallery: generate N pictures | N edit jobs at once, then accept / discard in the page | no change | 3 (same candidates store) |
| Scan card for lorebook | two 16k calls, both resumable, conducted by the page | no change | 4 |

Things the second pass found that the first draft missed: ✨ Edit portrait, the gallery generator,
Import & Remaster with its review queue, and Scan for lorebook. Things that can't or needn't move:
the **Local Forge** button (the browser calls Forge on your own network directly, so the server
can't reach it), web image search and URL import (already one proxy call each), Test chat, and
everything in group C.

Two details that follow from server-side follow-ups:

- **Reset** (the ↩ beside each Redo) restores the value from before the Redo. That "before" is in
  page memory today; the working card has to keep one previous value per field.
- **Candidates need a home.** Gen 4, takes and gallery pictures arrive as several results of which
  you keep some. The working card gets a "candidates" list (the History image-version files already
  work this way), cleared when you pick or discard.

## Phases

| Phase | What | Size | Ships alone? |
|---|---|---|---|
| 0 | Quick wins in the current design (below) | small | yes |
| 1 | Shared prompt modules + golden tests. No behaviour change | **large** | yes |
| 2 | Run engine and the **working-card id**; Generate (classic + search) text steps on the server; History save; one push; polling page; stop, resume, attach on load | medium–large | yes, behind a setting |
| 3 | Every image action on the server: new-card portrait, hosted fallback, Regenerate, Gen 4, Compare, takes, Edit, gallery; results written straight to the card or its candidates | medium–large | yes |
| 4 | Every other text action as a run: Inspire Me, 4 ideas, Revise / Remaster / Reduce / auto-fix, import queue, supporting cast, lorebook scan, and single-field Redo | medium–large | yes |
| 5 | Optional: hand-typed edits saved to the working card as you type (see Decisions) | medium | yes |

**Phase 0, worth doing whatever is decided about the rest:**

- Save the card to History right after step 4 instead of only at step 11.
- Make the group B calls streamed and resumable (Redo, example messages, notes, post-history, tags,
  alt greeting, Revise, the two idea calls). The idea calls and the non-streamed ones are exposed to
  iOS's 60-second cut and silent re-POST today.
- Collect pending jobs on page load, so a discarded tab at least gets its last result back.
- Fix the two parser bugs from the 2026-11-03 review ("The …" names; scenario titles) before the
  parser moves server-side, where a wrong name would be saved without anyone watching.

Between phases 2 and 3 there is a seam: the text is server-run but the portrait still needs the
page. A card whose page went away is saved without a portrait until you come back. Phase 3 closes it.

## Issues and risks

1. **Phase 1 is most of the cost and delivers nothing visible.** It can't be skipped. The alternative
   (the browser pre-builds every prompt and posts them) doesn't work, because steps 5 to 9 are built
   from the *output* of step 3.
2. **Per-device state has to move.** Recent-name history (used to avoid repeating names) lives in each
   device's `localStorage`. Server runs need it per user on the server, or names will repeat.
3. **API keys.** The run must use keys from the saved settings, since no page is attached to send them.
   The whole settings object is already posted to `/api/config`, so they should be there; confirm it
   for a user who has "remember keys" off. An upstream 401 must still never reach the browser as a 401.
4. **The image handlers are welded to a request.** `handleLocalComfyImage(req, res)` and the hosted
   route need splitting into plain functions the run can call. Hosted results come back as a URL that
   expires, so the run must fetch the bytes at once.
5. **Reference images** are several MB of base64 in page memory. The spec has to upload one once, and
   the server uses it as the portrait directly (today the browser does that at step 11).
6. **A proxy rebuild interrupts runs.** Deploys restart the proxy. With run files this becomes
   "Interrupted → Resume" and costs one repeated step. A small `GET /api/card-runs/active-count`
   would also replace reading `docker logs` to check nothing is generating.
7. **Closing the tab no longer stops anything.** That is the point, but it means a run you walked
   away from still bills. Needs a per-user cap on concurrent runs and the existing 20-minute ceiling.
8. **The live stream changes character.** Text arrives in 2-second chunks instead of token by token.
   If that feels worse, the page can tail the current step through the existing `/api/jobs/:id/stream`
   while it is visible; I'd add that only if you miss it.
9. **The API log panel** is filled from requests the browser made. Server-run steps must return their
   own log entries (request, response, usage) or the panel goes blank for runs.
10. **Stop semantics change.** Today Stop throws everything away. A server run will already have saved
    the card if the text step finished. See Decisions.
11. **Two paths during the move.** The old browser pipeline has to stay, behind a setting, until the
    server path has run for real on the phone. Every prompt change in that window touches shared code
    only, which is the reason phase 1 comes first.
12. **Step 1's 41 MB download** should be fixed in passing: the duplicate check belongs on the server.
13. **Testing.** Headless WebKit can't make iOS discard a tab, but this design makes the case
    testable for the first time: start a run, kill the page, load a fresh one, and the run must be
    found and finish. The engine itself can be tested against a fake model with a scratch copy of the
    proxy, as the push and PIN work was.
14. **Push presence logic gets simpler,** not harder: one report per run replaces "the page's last
    job finished". The early push described above goes away.

## Decisions for Joe

1. **Proxy or Python backend?** Recommended: proxy.
2. **How far to go?** Phases 0 to 4 make every AI action on the tab (new cards, later images,
   revisions, Redo) survive a lock, a discard and a device change, because each one is a run aimed at
   a working card on the server. What they don't cover is text you typed by hand and haven't saved:
   that still lives in the page until the next save. Phase 5 closes that by saving edits as you type.
   I'd decide on phase 5 after phase 4.
3. **Stop:** keep what finished (recommended: the card stays in History, marked incomplete) or delete
   it, as now?
4. **Live text:** 2-second polling (recommended first), or token-by-token from the start?
5. **Run state on the proxy's disk** (recommended) or in Postgres?
