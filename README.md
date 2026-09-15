# Tuttii FX Prototype

Forked from [`tuttii-mini-editor`](https://github.com/troyskinner3/tuttii-mini-editor)
on 2026-09-15 to isolate audio FX experimentation (filter sweeps, phasers, and
other DJ-deck/production-style effects) from the production-facing `/try`
editor. Deployed separately via its own GitHub Pages URL and embedded on an
unlisted Webflow page (`tuttii.app/prototype`, excluded from the sitemap, not
linked from anywhere) so it never affects the live demo. Everything below
this line is inherited from the original project and still applies here.

## FX (in progress)

A new "FX" library tab (same tap-to-expand pattern as Songs — one row per
effect type, tap to reveal its duration-variant chips in place) and a thin
FX lane (between Vocal and Beats) let you drag effect clips onto the
timeline.

Unlike Vocal/Beats, the FX lane is **freely positioned, not flush-packed**:
a clip lands wherever it's dropped (snapped to the nearest bar) and stays
there — dropping, moving, or trimming one doesn't push its neighbors
around, and `layout()` is never called for the `fx` track. The one
guardrail is that two FX clips still can't occupy overlapping bars (a
single shared filter node, see below, has nothing defined for what two
simultaneous automations on it would mean) — an overlapping drop is
rejected outright (with a live red-tint preview while dragging), a trim is
capped at the nearest neighbor, and a move reverts silently. Everything
else — move, trim, duplicate, delete, undo/redo — is reused as-is from
Vocal/Beats' generic clip machinery, just without the reflow step.

FX clips automate a single shared master `BiquadFilterNode` that both
Vocal and Beats route through before the destination — so an effect applies
to everything unless a future effect type says otherwise. Only one FX type
exists so far:

- **High Pass Sweep** (2/4/8/16-bar variants): highpass cutoff sweeps
  exponentially from 20Hz (neutral) up to 20kHz (peak, most content
  blocked) over the clip's duration, then ramps back to 20Hz in the final
  ~15ms so it doesn't leave the next section filtered. A hard instant
  reset was considered and rejected — an instantaneous filter-coefficient
  jump risks a click even though the signal itself is already near-silent
  up there; the brief ramp avoids that while still reading as a snap.

Known limitation, intentional for now: this is a **single global filter
node**, not one instance per clip — the FX lane can't have overlapping
clips yet (same non-overlap rule as Vocal/Beats today), so there's nothing
to combine. The planned future model (once a second effect type exists to
actually test it against) is per-clip node instances stacked in series,
ordered like layers in an image/video editor — vertical position in the FX
lane doubles as processing order, new clips insert at the top (processed
first), and the user can drag to reorder. `clip.effectId` is already on the
data model (not hardcoded to one row) specifically so that transition is a
rendering-layer addition later, not a data migration.

# Tuttii Mini Editor

A browser-based mini music editor prototype — drag stem-agnostic song sections
into Vocal/Beats lanes, trim/reorder/duplicate clips, and export the
arrangement as WAV or MP3.

Originally built as a single self-contained HTML file (`tuttii-mini-editor.html`,
kept at the repo root for reference); this is that same app restructured into
a real Vite project. See `tuttii-editor-claude-code-guide.md` for the full
design spec and decision log.

## Status

- **Pass 1 (done):** scaffolded into Vite, restyled to match the production
  app screenshots, mobile layout fixed (timeline pinned, library scrolls
  independently, compacted so ~2 songs are visible on a phone screen).
  Since revisited with a deeper fidelity pass: pill chevrons, custom
  volume slider, redesigned inspector, and the library rebuilt as a real
  Songs/Vocals/Inst/Silence tab structure (tap a song to expose its
  sections in place, tab controls what previewing plays) — matching the
  production app's actual structure, not just its colors.
- **Pass 2 (real audio wired for 2 of 3 songs):** placeholder oscillator
  audio replaced with real stem playback for real songs, alongside the
  original two synth demo songs (Neon Drive, Afterglow), which are
  untouched and still fully synthesized. **Project settings are locked
  at BPM 120, Key G# major.**

  **Dual-buffer model (implemented):** each real song ships four WAV
  files — native vocal/instrumental (the song's own BPM/key, used for
  library preview) and matched vocal/instrumental (pre-rendered
  externally to the locked project BPM/key, used for anything placed
  on the timeline). No live time-stretching or pitch-shifting happens
  in the browser. A section's matched-timeline timestamps are derived
  from its native timestamps × (nativeBPM / 120) — measured once,
  against the native file only.
  - `SONGS[].isReal`, `.nativeBpm/.nativeKey`, `.stems.native/.matched`,
    and per-section `.nativeStart/.nativeEnd` (raw, user-supplied) plus
    derived `.durBars/.matchedStart/.matchedEnd` — all in `src/main.js`.
  - Lazy per-song preload (`preloadSongAudio`): fetch + `decodeAudioData`
    for all 4 stems, kicked off the first time a song's row is expanded
    in the library, cached on the song object. A `.lib-loading` state
    shows while decoding; sections aren't interactive until ready.
  - Library preview (tap a chip) plays a native-buffer slice at the
    song's real BPM/key. Dropping a section on the timeline tags the
    clip with `songId` + a `sourceStart/sourceEnd` offset into the
    matched buffer; `scheduleRealClip()` plays that slice via
    `AudioBufferSourceNode.start(at, offset, duration)`. Trimming a real
    clip's handles adjusts `sourceStart`/`sourceEnd` (anchoring the
    untouched edge), clamped to the matched buffer's actual length —
    so a trim can reveal more of the real stem on either side, same as
    the design called for. Playback resuming mid-clip (after a scrub)
    passes the correct offset into the buffer.
  - WAV export renders real clips into the offline mix same as before —
    `scheduleClip` transparently branches on `clip.songId`.

  **Song 1 — "Be With You" (Duke Dylan):** BPM 117, Key A major.
  13 sections. Audio in `public/audio/be-with-you/`. Working end-to-end
  (preview, drop, trim, playback, export) — verified with Playwright.

  **Song 2 — "Do You Remember" (waitwhat):** BPM 122, Key G# major.
  11 sections. Audio in `public/audio/do-you-remember/`. Working
  end-to-end — verified with Playwright.

  **Song 3 — "Smoker Lungs" (Zachary Scott Kline):** BPM 127, Key G major.
  7 sections. Audio in `public/audio/smoker-lungs/`. Sits between the
  other two songs in the library (order is just array order in
  `SONGS`, no separate sort step). Working end-to-end — verified with
  Playwright. Source files came in as a GitHub release
  (`audio-smoker-lungs`) rather than a direct upload: a native
  127bpm/G-major WAV pair plus an already time-stretched-to-project
  pair (labeled "Freeze" — an Ableton freeze-render, filename tempo/key
  left unchanged from before the freeze). Identified which was which
  by decoded duration, not the filename: native measured 168.4s
  matching the given section timestamps, matched-to-120bpm measured
  178.2s — matching native × (127/120) to within 0.03%, the same
  scale-factor check used for songs 1 and 2. Matched pair encoded
  whole; the 7 section-preview slices were cut from the native pair at
  the given native timestamps, both at 128kbps MP3 like the existing
  songs.

  **Stem format: MP3, not WAV.** Originally shipped as WAV specifically to
  avoid MP3 encoder lead-in silence breaking bar-accurate scheduling.
  Switched to MP3 after empirically verifying (via ffmpeg +
  Playwright/Chromium `decodeAudioData` on the actual stem files, not
  just a short test clip) that decoded duration and native/matched
  ratios match the mathematically-derived scale factor to within
  0.0002s across full ~3-minute files — no meaningful drift. **Caveat:**
  only verified in Chromium; Safari has a documented history of MP3
  gapless decode quirks, so worth a spot-check on a real iPhone before
  final launch, though not blocking for internal review.

  **Loading model — per-section preview slices.** Preloading the whole
  native stem pair per song (even after switching to MP3) still meant
  several MB before any section could be previewed — measured ~58s to
  ready on a throttled ~1.5Mbps connection. Since library preview always
  plays a section's exact, never-trimmed window, there was never a real
  reason to need the whole song for it: each section is now pre-sliced
  (at build time, from the original masters) into its own tiny MP3 —
  `public/audio/<song>/sections/<sectionId>-<vocal|beats>.mp3`, a few
  hundred KB — fetched and decoded lazily, only on first tap of that
  chip. Measured result on the same throttled connection: ~2.8s for the
  longest section, ~280ms on a normal connection. The matched (timeline)
  pair is unchanged — one whole-file pair per song at 128kbps
  (`<song>/matched-{vocal,beats}.mp3`), still lazy-loaded on first drop,
  since trimming can extend a clip into the full matched stem. Total
  repo audio: ~33MB (2 songs at ~22MB; +~11MB for Smoker Lungs). All of it is mirrored
  (same content, git-deduped so no extra data) at a top-level `audio/`
  for GitHub Pages' raw-tree serving — see below.

  **Playback pauses on edit.** Editing the timeline (drop, move, trim,
  duplicate, delete, volume, undo, redo) while playback is running used
  to leave audio playing against a stale snapshot of the timeline, out
  of sync with what's now on screen. Live-updating in-progress playback
  to match was the other option; pausing (via a single `pause()` call
  inside `commitHistory()`, `undo()`, and `redo()`) was simpler and
  avoids the whole bug class.

  **Mobile audio (resolved, real device confirmed).** iPhone Chrome
  (WebKit under the hood, same audio rules as Safari) produced no sound
  at all, from the very first load, no error banner. Diagnosed with a
  temporary on-screen debug readout showing the live `AudioContext`
  state directly off the real device (since none of this is
  reproducible in Chromium/Playwright — WebKit-specific behavior).
  Turned out to be two separate, real bugs, both now fixed and confirmed
  working on-device:
  - `togglePreview()` fired `ctx.resume()` without awaiting it before
    scheduling (unlike `play()`, which already did this correctly) —
    could schedule nodes on a context not yet actually running.
    `ensureAudioReady()` now centralizes this for both call sites, and
    also recreates the context outright after it comes back "zombified"
    from being backgrounded (resume() claims success, but the clock
    never actually resumes) rather than trusting resume() to work.
  - The real, deeper cause of total silence: a raw `AudioContext`'s
    default output is "ambient" audio on iOS, which the ring/silent
    switch is allowed to mute outright — confirmed via the debug
    readout showing a healthy running context, a genuinely scheduled
    node, and decoded buffers carrying real (non-silent, peak ~0.3-1.0)
    samples, yet still nothing audible. Real `<audio>`/`<video>`
    playback isn't subject to that. First fix (routing the whole graph
    through a `MediaStreamAudioDestinationNode` into an `<audio>`
    element) produced real sound but glitched/stuttered consistently —
    a known WebKit instability with that combination. Final fix:
    `ensureSilentLoop()` leaves the main graph on `ctx.destination`
    entirely untouched, and separately loops a tiny silent WAV through
    an independent `<audio src>` element purely to claim the page's
    audio session as "playback" category — iOS applies that page-wide,
    not per-source, so the main graph benefits without its signal path
    ever touching the fragile bridge.
  - Also stops iOS's native text-selection UI (the blue circle-handle)
    from hijacking drags on `.clip`/`.section-chip`/`.handle` —
    `touch-action: none` alone doesn't block that; needs
    `-webkit-touch-callout: none` + `user-select: none` too.

  **Preview deploy:** this branch is directly servable as a static
  site with no build step — `index.html` and the stem paths in
  `src/main.js` use plain relative paths (no leading slash), which
  browsers resolve against the page's own URL, so the exact same
  source works from the dev server, a normal root deploy, or a GitHub
  Pages project subpath. GitHub Pages needs either a public repo or a
  paid plan for a private one — the repo currently holds real licensed
  stems, so that's a call for Troy, not something to flip on
  unilaterally. Also: the Artifact preview link (used for quick visual
  iteration in chat) serves from a different origin than this repo, so
  it can't reach `/audio/...` at all — that channel is visual-only,
  not for hearing audio.

  **Real waveforms on placed clips.** `computeWaveformBars()` samples real
  per-bin peak amplitude from a clip's actual range of its song's matched
  buffer, so a quiet or silent stretch in a vocal genuinely shows as
  low/flat bars — not the old decorative sine pattern (still used as a
  brief placeholder before a freshly-dropped clip's matched audio finishes
  loading). Scoped to the timeline only, not library preview chips, since
  those load lazily per-tap and prefetching every section's audio just for
  thumbnails would undo the near-instant preview fix above.

  **Scroll vs. reorder on filled lanes.** Once clips fill a lane, a swipe
  meant to scroll the timeline was getting caught as a clip-reorder drag —
  both are horizontal gestures on `.clip`, with no axis to tell them apart
  (unlike the library's chip-row drag-out, which uses a vertical lift for
  exactly this reason). Fixed with a brief hold (160ms) that "commits" a
  press to a reorder; moving more than a few px before that elapses commits
  it to a scroll instead, replicated by hand via `scrollArea.scrollLeft`
  since `touch-action: none` (needed for the reorder drag itself) means
  native scrolling was never going to kick in regardless.

  **Pinch-to-zoom on the mobile timeline.** Two-finger pinch inside
  `#scrollArea` rescales `BAR_PX` (pixels per bar) between 0.5x and 2x of
  its base value, so clips shrink/grow accordingly; desktop is untouched —
  the whole feature is gated on `e.pointerType === "touch"`. `BAR_PX` went
  from a `const` to a `let`; zooming tears down and rebuilds the bar grid
  (`buildTimelineGrid()`) and re-renders clips/playhead against the new
  scale, then adjusts `scrollLeft` to keep the pinch midpoint anchored to
  the same bar on screen rather than snapping to the left edge. The one
  real complication: a pinch's first finger can already be mid-gesture
  (dragging a clip, trimming a handle, scrubbing) by the time the second
  finger lands. Each of those three gesture-starters now registers a
  `cancelActiveGesture` callback that a second touchdown calls once —
  detaching the in-progress gesture's listeners and re-rendering from the
  untouched clip data, without committing whatever move/trim/seek was
  underway — before pinch tracking takes over. Verified with real
  multi-touch simulation (CDP `Input.dispatchTouchEvent`, since Playwright's
  regular mouse/touchscreen APIs can't drive two independent touch points):
  pinch-out clamps to 2x, pinch-in clamps to 0.5x, and every other timeline
  gesture (tap-to-inspect, drag-to-reorder, trim, scrub) still works
  correctly after zooming.

  **Default zoom starts at the floor.** `BAR_PX` now initializes to
  `MIN_BAR_PX` (the 0.5x fully-zoomed-out level) instead of the base
  value — same min/max range as before, just a denser starting point so
  more of an arrangement is visible without any zooming. Users can still
  pinch in up to the existing 2x ceiling, and back out only as far as
  this same floor (unchanged clamp in `setZoom`).

  **Desktop zoom buttons.** Pinch-to-zoom is touch-only, so mouse users
  had no way to reach anything past the new denser default. Two small
  −/+ buttons (`#zoomOutBtn`/`#zoomInBtn`) sit in the timeline header,
  in the 60px slot a dead decorative `.spacer` div used to hold — call
  the same `setZoom()` pinch uses, anchored on the visible timeline's
  center instead of a pinch midpoint. Shown only where pinch isn't
  already available: `.zoom-controls` is `display:none` by default,
  overridden to `flex` under `@media (pointer: fine)` (the same signal
  a device's primary input being a mouse vs. touch), so mobile's layout
  and gesture-only zoom are completely untouched — no JS device
  detection needed. Both buttons disable themselves at the respective
  clamp (`updateZoomButtonsDisabled()`, called from `setZoom()` so it
  stays in sync with pinch too, even though pinch can't reach these
  buttons).

  **Visual fidelity pass against a real production app screenshot.**
  Prompted by a side-by-side comparison against an actual Tuttii mobile
  app screen (not just the earlier reference screenshots used for Pass
  1's initial styling). Changes:
  - Export: the WAV/MP3 buttons themselves are now standalone gradient
    pills with a soft glow instead of small flat buttons, matching the
    real app's Export button's visual weight. The "Export" label above
    them stays — a first pass dropped it along with the old bordered
    box, but that took real information away (what those two buttons
    even are, to a first-time visitor), which was never the point;
    restyled the label instead (small-caps monospace, matching the
    toolbar pills' typographic treatment) rather than removing it.
  - Transport: added Rewind/Fast-Forward buttons (±1 bar per press,
    clamped to the timeline bounds) between skip-to-start/play and
    play/locate, matching the real app's 5-button row. Enlarged and
    glow-shadowed the play button to match its visual prominence
    there. (A live progress bar also went in alongside these in the
    same pass, replacing the old static `.grabber` nub in the timeline
    header — reverted per the same "restyle, don't replace" principle
    below, since it was a new element/behavior rather than an existing
    one restyled.)
  - Clip waveforms: taller bars (21px → 27px) and higher opacity
    (0.7 → 0.85) for more visual punch, closer to the real app's dense,
    high-contrast look.

  Library row subtitles stay as "Tap to view sections" — a first pass
  swapped this to the artist name to match the real app's subtitle
  content, but the ask was to restyle existing text/elements, not
  replace their content/copy with the real app's own. Same principle
  as the Export label above: matching the production app's *look*
  (fonts, colors, spacing, shapes) is the goal, not porting over its
  copy or trading away elements that carry real information here.

  **Real cover art.** Each song's library thumbnail now shows its
  actual cover image (`song.thumbImage`, an `<img>` with
  `object-fit: cover`) instead of the gradient+emoji placeholder —
  the placeholder styling (`song.thumbColor`/`.thumbIcon`) stays in
  the code as a fallback for any future song added without art. Files
  live at `public/audio/<song>/cover.{png,jpg}` (mirrored at the
  top-level `audio/` like the stem files, same reasoning). Delivered
  as GitHub release assets (same channel as the audio stems) rather
  than a direct link — Bandcamp and Google's image-cache hosts are
  both blocked by this environment's egress policy, and images pasted
  into a release's *description* box upload to a session-scoped
  `github.com/user-attachments/...` path that isn't fetchable either;
  actual release *assets* (the same `.../releases/download/{tag}/...`
  path the audio files use) are the one channel confirmed to work.

  **Deliberately not changed, and why:**
  - The real app's sparkle "auto-match" toolbar icon and library
    "+ Add" button — both non-functional in this demo (no real
    key/BPM matching, no user-uploaded songs), and a demo shouldn't
    show controls that do nothing when tapped.
  - The song-row checkmark badge, kept instead of the real app's
    drag-handle dots — ours actually means something specific here
    ("pre-matched, ready to drag"; see its tooltip), whereas a
    drag-handle would imply library reordering this demo doesn't
    support.
  - The bottom tab bar (music/logo/settings) — implies multi-screen
    app navigation that doesn't apply to this single-view embed.

- **Pass 3 (optional):** split `src/main.js` into smaller modules.

## Develop

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
npm run preview
```
