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
around, and `layout()` is never called for the `fx` track. Everything
else — move, trim, duplicate, delete, undo/redo — is reused as-is from
Vocal/Beats' generic clip machinery, just without the reflow step.

**FX clips can stack (layering).** Every FX clip has a `.layer` (lower =
higher priority = processed first = visually closer to the top of the FX
lane), assigned by a monotonically-decreasing allocator (`allocateTopFxLayer`)
so a brand-new clip always lands strictly on top of everything else — no
renumbering needed. A clip's visual row (`fxSlotFor`) is just "how many
higher-priority clips currently overlap me in time," recomputed fresh on
every render, so the lane only grows where clips actually coexist (capped
at `MAX_FX_LAYERS`, 4 for now), not just because many exist somewhere on
the timeline. Dragging a clip mostly vertically (past a small threshold)
swaps its priority with whichever overlapping clip is immediately next in
that direction — the FX equivalent of dragging a layer up/down a stack in
an image editor; dragging mostly horizontally still just repositions it in
time, and `.layer` is untouched either way unless that vertical swap fires.
The clip visually lifts and follows the finger vertically the whole time
it's held (not just on release) — without that, an up/down drag looked
like it silently did nothing until you let go, reading as broken rather
than as an intentional gesture.

Audio-wise, each FX clip gets its **own dedicated audio unit** (`buildFxUnit`
via `buildFxChain`, rebuilt fresh every `play()`/export call) — for a
simple filter sweep that's a single `BiquadFilterNode`; a phaser needs
several nodes wired together internally but still exposes one input/output
pair. Units are chained in series ordered by `.layer` before the
Vocal/Beats mix reaches the destination. A unit only departs from neutral
during its own clip's window, so simply keeping every FX clip's unit
permanently in that series chain for the whole run is enough to get
correct layering for free — no dynamic connect/disconnect scheduling
needed, and two overlapping clips just both apply during their shared
window, in priority order. The one thing that *does* need explicit
teardown between runs is a phaser's LFO oscillator (a live source, unlike
a filter's passive coefficients) — `teardownLiveFxChain` disconnects and
stops every node the previous live-context run built, called both from
`pause()` and at the start of the next `buildFxChain`, so nothing
accumulates across repeated play/pause cycles. (Not needed for exports —
each one gets its own throwaway `OfflineAudioContext`.)

Three effect types exist so far:

- **High Pass** (2/4/8/16-bar variants): cutoff sweeps from 20Hz
  (neutral) up to 15kHz (peak — kept short of the full 20kHz, which cut
  too much of the mix to still read as musical) over the clip's curve,
  ending back at 20Hz so it doesn't leave the next section filtered — see
  "Custom curves" below for how that end-at-neutral guarantee actually
  works and how the curve's shape is user-editable.
- **Low Pass** (2/4/8/16-bar variants): the mirror image — cutoff
  sweeps from 20kHz (neutral) down to 20Hz (the classic DJ "breakdown,"
  where going all the way to near-total muffling is the point, unlike high
  pass's pulled-back peak) and back up to 20kHz.

  Both share the same scheduling code (`scheduleFxSweep`) parameterized by
  `fromHz`/`toHz` off the `FX_EFFECTS` entry — one
  `exponentialRampToValueAtTime` call per *straight* curve segment (see
  "Custom curves" for why that's exact, not an approximation) plus a
  handful more for any segment the user's actually bowed, via
  `fxCurveScheduleBreakpoints`.
- **Phaser** (2/4/8/16-bar variants): Web Audio has no native phaser
  node, so it's built from primitives — 6 series `allpass` `BiquadFilterNode`s
  (`stages`), all modulated in phase by one shared LFO (a 0.3Hz sine
  oscillator, `lfoRateHz`, fanned out to every stage's frequency param at
  once — in-phase motion across all stages is what creates the moving
  notches), then crossfaded against the dry signal via two gain nodes. The
  "curve" here is that dry/wet crossfade, 0 (fully dry) to 1 (fully wet)
  and back to 0 at the end, same shaped rise-then-reset envelope as the
  filter sweeps but via **linear** interpolation (`schedulePhaserSweep`)
  rather than exponential — a proportion like
  dry/wet has no meaningful "ratio," and 0 is a needed endpoint that
  `exponentialRampToValueAtTime` can't reach at all. Deliberately simple
  for this first pass, per an explicit "start simple, iterate later": fixed
  LFO rate (not tied to clip length), no feedback/resonance path, and the
  curve controls only dry/wet — allpass center frequency (800Hz) and LFO
  depth (±600Hz) are constants for now, not curve-controlled.
- **Washout** (2/4/8/16-bar variants): a synthetic-impulse reverb
  wash (`reverbImpulseBuffer` — 2.5s of exponentially-decaying stereo white
  noise through a `ConvolverNode`, since there's no impulse-response audio
  asset to load) crossfaded in the same way as the phaser's dry/wet, with
  the combined dry+wet signal also passing through a highpass that rises
  from 20Hz to 300Hz over the same envelope — a mild thinning of the low
  end, not the dramatic full-range sweep of the standalone High Pass
  effect. Both curves reuse the existing scheduling functions unmodified
  (`schedulePhaserSweep` for the crossfade, `scheduleFxSweep` for the
  filter) rather than inventing new curve math, since each just reads the
  `FX_EFFECTS` fields it already knows about (`fromWet`/`toWet` and
  `fromHz`/`toHz` coexist on the same entry).
- **Echo Throw** (2/4/8/16-bar variants): a feedback delay — one
  `DelayNode` set to an eighth note at the locked 120bpm (`delaySec`,
  fixed, not curve-controlled) with a 45% feedback loop, crossfaded in via
  the same dry/wet curve as phaser/washout. The longer a passage sits
  under this effect, the more the repeats dominate over the dry signal.

The stacking/layering system this all runs on (`.layer`, `fxSlotFor`,
`allocateTopFxLayer`, `swapFxLayer`, the vertical-drag gesture) is
documented above, in the FX lane paragraphs.

### Custom curves

Tapping an FX clip opens the shared inspector (same one Vocal/Beats
clips use), which for an FX clip shows a curve editor instead of the
volume row (and hides the generic move/trim hint text below it, which
described Vocal/Beats' handles and read as confusingly misattributed to
the curve above it once this editor existed). Modeled on Xfer's LFO Tool
(the explicit reference) rather than a Bezier/tangent-handle editor: any
number of draggable point-nodes, connected by straight lines, each node
literally sitting on the curve rather than pulling at it from off the
path. The two end nodes are permanently fixed at value 0 (locked
position, no pointer handler at all — not draggable, not selectable, not
deletable). That lock *is* the entire "always resets cleanly" guarantee:
earlier this needed a separate hardcoded short ramp bolted onto the end
of the curve; with both ends pinned to neutral, the curve itself carries
that guarantee, and the user fully controls how gradually or sharply it
gets there for everything in between.

The data model stays thin: `clip.curve`, when present, is
`{nodes: [{t,v}, ...], curves: [n|null, ...]}` (one `curves` entry per
segment, `curves.length === nodes.length - 1`), sorted by time. The
default is three nodes — `{t:0,v:0}`, a peak node, `{t:1,v:0}` — rising
across essentially the whole clip to a peak that sits `FX_DEFAULT_DROP_SEC`
(20ms) before the end node, so the two connect with a short, sharp drop
read as a sudden kick-and-release rather than a gradual climb-and-fall.
That's a fixed *absolute* duration, deliberately — an earlier version
placed the peak at the closest position the drag clamp allowed
(`1 - FX_CURVE_MIN_NODE_GAP`, a fixed *fraction*), which put it exactly
2 SVG-pixels from the edge and looked right, but a fixed fraction's
absolute duration scales with the clip: fine (~40ms) at 4s, a
noticeably slow ~320ms at 32s. Carrying over the spirit of the fixed
~15ms reset ramp this curve model replaced needed an actual fixed
duration, converted to whatever fraction that is for *this* clip's
length — 20ms (close to that original ~15ms, with just enough headroom
to stay a real, schedulable ramp) reads the same regardless of whether
the clip is 2 bars or 16; `FX_CURVE_MIN_NODE_GAP` is kept below the
fraction that works out to on the longest (16-bar) clip specifically so
it never overrides the target there. The middle node is a completely
ordinary, fully-draggable node
like any other, repositionable in both time and value from the moment
the inspector opens — even before any custom curve has actually been
committed — and dragging it left, say, turns the shape into a triangle.
`fxCurveFracAt` is the single point where the FX engine decides between
a clip's custom nodes and the default, evaluated via `fxCurveValueAtT`.
`scheduleFxSweep` and `schedulePhaserSweep` both call through it (via
`fxCurveScheduleBreakpoints`, see below), so a custom curve applies
wherever the default did, including a washout's two simultaneously-curved
parameters.

Each segment is internally a quadratic Bezier whose control point's time
is pinned to the segment's own midpoint. That's a deliberate constraint,
not an implementation detail to hide: fixing the control point's time
coordinate makes the curve's time axis exactly linear (no root-solving
needed to invert time → parameter, the way a from-off-the-path
tangent-handle Bezier would need). With no stored `curves[i]`, the
control value defaults to the segment's straight-line midpoint value,
which makes the Bezier degenerate to an actual straight line — LFO
Tool's own default for a segment with no tension applied. Because every
value involved is clamped to 0..1, the convex-hull property of a Bezier
curve guarantees the curve fraction itself never leaves `[0,1]` either;
`fxCurveFracAt` still clamps defensively since the downstream Hz/wet math
assumes that range.

Scheduling reproduces the curve via `fxCurveScheduleBreakpoints`, which
walks the node list directly rather than sampling at a fixed count across
the whole clip (an earlier version did exactly that, at 48 samples — the
default curve's peak-pressed-near-the-end shape is what exposed it as
wrong: on a 32s clip, 48 even samples land ~0.7s apart, vastly coarser
than the curve's own 20ms final segment, so the schedule never actually
reached the peak or reproduced the real drop duration). A straight segment gets
exactly one checkpoint, at its own end node, and that's not an
approximation to trim down — it's exact: within a straight segment the
curve fraction is affine in time, so Hz (`fromHz*(toHz/fromHz)^frac`,
exponential-of-affine) is a pure exponential function of time and wet
(`fromWet+(toWet-fromWet)*frac`) a pure linear one, which is exactly what
`exponentialRampToValueAtTime`/`linearRampToValueAtTime` already produce
between two points on their own. Only a *bowed* segment (a quadratic
Bezier in fraction-space, not affine) actually benefits from intermediate
samples, so only those get `FX_BOW_SUBSAMPLES` (12) of them — scaled to
that one segment's own span, however short or long it is, rather than
diluted across the whole clip.

Add (+) inserts a new node into the current largest gap, sitting right on
the curve's existing value there so adding one never itself changes the
shape until it's dragged. Tapping a node selects it (a second tap
deselects); the delete button is enabled only while a deletable
(non-endpoint) node is selected. Dragging a node keeps its time coordinate
clamped between its immediate neighbors, so nodes can't cross over each
other and leave "the curve" ambiguous at some instant. A small handle
also sits on the curve at each segment's own midpoint — grab it and drag
vertically (horizontal movement is ignored) to bow that one segment into
a curve, LFO Tool-style, without needing separate off-curve tangent
handles; `startCurveSegDrag` solves for the Bezier control value that
puts the curve's own rendered midpoint (the point actually being dragged,
not the abstract control point) under the pointer.

Adding or deleting a node only resets the one segment directly involved,
not the whole curve. Deleting a node merges the two segments it touches
into a single new segment spanning the gap — that merged segment resets
to straight (`fxSegCurvesAfterNodeDelete`), since a single bow value
can't represent what were two independently-shaped segments, but every
other segment's bow is untouched. Adding a node is the mirror case: it
splits one segment into two new straight ones (`fxSegCurvesAfterNodeAdd`),
again leaving every other segment alone. Preserving the exact shape
through either change would need re-deriving control points via Bezier
subdivision, which only works cleanly if a control point can sit off its
segment's midpoint (it can't, here); not worth the complexity when the
one segment actually being restructured resetting to straight is already
the intuitive behavior. Opening the
inspector on a clip with no custom curve only *previews* the default
shape — nothing is written until an actual add/drag/delete/bow happens,
so merely looking at a clip never silently converts it. Reset deletes
`clip.curve` entirely, reverting to the procedural default. All of these
edits go through the normal undo/redo history like any other clip edit.

Every draggable point (nodes and segment handles alike) renders as a
small visible dot with `pointer-events: none`, sitting on top of a much
larger invisible circle (`.fx-curve-node-hit` / `.fx-curve-seg-hit`, 16
and 14 SVG user units respectively) that actually owns the pointer
handler — the visible dot alone was too small a target on a touch screen
even though it looked perfectly grabbable. The `<svg>`'s own `viewBox` is
padded out beyond the plotted 200×120 area for the same reason: a
hit-circle centered right at the plot's edge (e.g. the default curve's
locked `v=0` endpoints) would otherwise get silently clipped by the
SVG's own overflow, shrinking exactly the touch target this exists to
enlarge. The padding is asymmetric (`FX_CURVE_PAD_TOP`/`_RIGHT` at 18
units, `_BOTTOM`/`_LEFT` at 30/34) now that it also has to fit the axis
tick labels below and to the left — top/right only ever need to clear a
hit-circle's bleed, the same as before.

The `<svg>` uses `preserveAspectRatio="none"` so the curve/grid can
stretch to fill the box at a fixed height regardless of viewport width —
exactly what also stretches every circular marker into an ellipse, more
so the wider the box gets (the height is fixed, so only the x-scale
grows; dramatic on a wide desktop window, subtler on a narrow phone).
Rather than give up the non-uniform stretch everywhere, only the four
circle classes (`.fx-curve-node`, `.fx-curve-node-hit`,
`.fx-curve-seg-handle`, `.fx-curve-seg-hit`) get a corrective
`transform: scaleX(var(--fx-curve-unsquish))`, computed in
`updateFxCurveUnsquish` from the box's actual rendered aspect ratio and
applied via `transform-box: fill-box` so each circle scales around its
own center rather than the group's. It's recomputed whenever the
inspector opens on an FX clip and on window resize, so a dot reads as a
true circle at any viewport width and stays a constant pixel size rather
than growing with the box.

Grid lines and matching tick marks (same positions, solid, just outside
the plot in the padding margin) sit on both axes, each now labeled —
reading a node as "about halfway through the section, around 3kHz" at a
glance, same as a real DAW automation lane. The two axes use different
tick logic, though, since they mean different things: the value axis
(horizontal lines) stays at fixed 25/50/75%, since "a proportion of the
way from neutral to full effect" is meaningful at any clip length; the
time axis (vertical lines) is bar-aligned instead via `fxCurveBarTicks`
(the largest step from `[1,2,4,8,16,...]` that still keeps the clip to
at most 4 segments — a label on every bar for a short clip, every few
bars for a long one, and never a fractional bar number), since "25%
through" isn't a bar count a musician thinks in. Both only label the
interior ticks, the same reasoning as the value axis never labeling
0%/100%: the locked endpoint nodes already mark the very start and end.

Each axis's tick *values* are effect-aware (`fxCurveYAxisInfo`): a
filter sweep's curve drives a cutoff frequency directly, so its axis
reads "Frequency (Hz)" with real Hz values (`fxFormatHz`, e.g. `2.9k`)
at each gridline — computed through `fromDisplayV` first, so an inverted
Low Pass's labels correctly read as *decreasing* toward the bottom just
like its curve does. Phaser/washout/echo's curve drives a dry/wet mix
instead, so their axis reads "Mix" with percentages. (Washout's curve
also drives a secondary, narrow-range highpass sweep alongside its mix,
same as it always has — Mix is just the more legible thing to put on
the axis, and that secondary sweep isn't itself independently editable
that this axis would need to reflect.) The Y-axis title text is
resolved per clip; the X-axis title ("Bars") is a static label — there
was never a second axis semantics to account for there.

The X-axis tick labels are the one part of this whole panel that can go
stale without a re-render: a clip's node positions are stored as time
*fractions*, so trimming doesn't touch `clip.curve` at all, but the bar
*numbers* a given fraction corresponds to depend on `clip.duration`,
which trimming changes directly. `startClipTrim`'s `onUp` re-runs
`drawFxCurveGrid` (not a full `drawFxCurve` — the curve's own shape is
unaffected) whenever `curveEditorClip` still points at the clip just
trimmed, i.e. whenever that exact clip's curve editor happens to already
be open (opening the inspector never happens automatically on a trim,
but it can already be open from an earlier tap).

Text elements get the same `--fx-curve-unsquish` correction as the
circular markers, with one difference: `transform-origin` is pinned to
the label's own anchor edge (`right center` for the right-aligned value
labels, plain `center` for the centered bar labels, which is already
where `text-anchor="middle"` anchors) rather than the shape's geometric
center the way a circle uses. A circle scaling around its own center
never visibly moves; text scaling around its center would, since a
right- or center-anchored string's *edge* is what's meant to stay fixed
against its tick, not its middle — pinning the origin there is what
keeps a label flush against its own gridline at every viewport width
instead of drifting off it as the correction factor changes.

**Display inversion for a falling filter sweep.** The stored curve is
always "0 = neutral, 1 = full effect" — that's what the audio math
reads, and it never changes. High Pass's cutoff *rises* as the effect
ramps in (20Hz → 15kHz), so "up the graph = more effect" already lines
up with "up the graph = higher cutoff frequency." Low Pass's cutoff
*falls* (20000Hz → 20Hz), so the same raw-fraction curve would render
as an identical-looking rise-then-drop shape while the actual cutoff
frequency does the opposite thing — backwards for anyone reading the
vertical axis as cutoff frequency, a DAW automation lane's usual
convention, even though the audio itself is correct. `curveEditorInverted`
(set in `renderFxCurveEditor` via `fxCurveEffectIsInverted`, true
whenever an effect's `toHz < fromHz`) flips *only* the display:
`toDisplayV`/`fromDisplayV` (both just `1 - v`) sit at every point data
crosses the editor's screen-space boundary — rendering a node, segment
handle, or path point, and reading a dragged pointer position back into
stored data — so `curveEditorNodes`/`clip.curve` keep meaning exactly
what they always have, and Low Pass's default shape now renders as the
mirror image of High Pass's (starts near the top/neutral, dips to the
bottom/peak effect, snaps back up) instead of looking identical to it.
Existing saved Low Pass curves are unaffected audibly — this is a pure
presentation-layer transform, not a data migration.

Delete already worked for FX clips before this curve editor existed (the
inspector's shared duplicate/delete icons are generic across all three
lanes) — it just wasn't obvious it was there, which is part of why this
whole panel exists.

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
  tab structure (tap a song to expose its sections in place) — matching
  the production app's actual structure, not just its colors. Top-level
  tabs are now just Songs/Silence/FX; Vocals/Inst started as their own
  top-level tabs but were folded into a Songs sub-tab (Original/Vocals/
  Instrumental, defaulting to Original) that only changes what tapping a
  section previews — three tabs whose sole difference was "what does a
  tap play" didn't earn separate top-level billing, and the same
  sub-tab pattern is intended to extend to FX once its library grows
  past the current 5 effect types.
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

  **Play button felt unresponsive on a slow first press.** `play()`
  already awaited a song's matched pair before scheduling anything (so a
  clip never silently played nothing), but gave no feedback while doing
  so — on a real device over a real connection that wait is genuinely
  several seconds (that ~6.5MB, ~3.4-minute matched pair above, fetched
  and decoded in full to play what might be one 8-bar, ~16-second clip —
  the tradeoff this file already documents, not a bug), and the button
  just sat there looking broken. It now spins while waiting (`.play-btn
  .loading`, driven by a `playStarting` flag) and ignores a second tap
  during that window — without the guard, a double-tap while still
  loading would call `play()` twice concurrently, and the two calls'
  `stopAllNodes()`/scheduling could race each other.

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
