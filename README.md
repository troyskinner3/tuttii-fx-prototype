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
renumbering needed. A clip's visual row (`fxSlotFor`) used to just be "how
many higher-priority clips currently overlap me in time," which sounds
right but can leave a visibly blank row: if a new clip overlaps only some
of an existing stack (not the ones already at the top), everything it
does overlap gets pushed down by one, but nothing moves into the row they
vacated. It's standard interval-graph coloring instead now — walk every
FX clip from highest priority to lowest, giving each the smallest row
index not already claimed by an overlapping, higher-priority clip. This
greedy-MEX approach can't produce a gap (reaching row *k* at all requires
rows `0..k-1` to already be taken by overlapping neighbors), while still
being recomputed fresh on every render with no separate sweep-line pass,
so the lane only grows where clips actually coexist (capped at
`MAX_FX_LAYERS`, 4 for now), not just because many exist somewhere on the
timeline. Dragging a clip mostly vertically (past a small threshold)
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

Eight effect types exist so far:

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
  `exponentialRampToValueAtTime` can't reach at all. LFO rate is now a
  per-clip slider (see "Secondary controls" below); no feedback/resonance
  path yet, and the curve still controls only dry/wet — allpass center
  frequency (800Hz) and LFO depth (±600Hz) remain constants, not
  curve-controlled or exposed as a control yet.
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
- **Tremolo** (2/4/8/16-bar variants): amplitude modulation — a sine
  `OscillatorNode` (`lfoRateHz`, 5Hz default) fans into a gain node's
  `gain` param, riding on top of a base value that the curve also moves:
  at curve value 0 the base sits at 1 and the LFO's own swing is scaled
  to 0, so gain stays pinned at 1 (no modulation, silent-passthrough
  neutral); as the curve rises toward 1, the base drops to 0.5 and the
  LFO swing grows to ±0.5 in lockstep, so gain sweeps the full 0..1
  range (silence at each trough) — one shared `depth` value out of
  `fxDepthEnvelope` (shared with Auto-Pan, see below) drives both the
  base and the swing together rather than two independently-curved
  params. This is a modulation-depth envelope, not a dry/wet crossfade,
  since there's no separate dry path to blend against. LFO rate is a
  per-clip slider (0.5–20Hz).
- **Auto-Pan** (2/4/8/16-bar variants): the same idea as tremolo but
  panning instead of gain — a sine oscillator (`lfoRateHz`, 1Hz default)
  drives a `StereoPannerNode`'s `pan` between `-depth` and `+depth`,
  where `depth` itself ramps from 0 (curve 0, centered/neutral) up to 1
  (curve 1, full hard-left-to-hard-right sweep) via the same
  `fxDepthEnvelope` helper tremolo uses. The panner's own base pan value
  never needs to move — only the LFO's depth does — so this is a single
  param out of `fxDepthEnvelope` rather than tremolo's related pair, and
  again a depth envelope rather than a dry/wet crossfade. LFO rate is a
  per-clip slider (0.1–10Hz).
- **Bitcrusher** (2/4/8/16-bar variants): sample-and-hold-free bit-depth
  reduction via a `WaveShaperNode` — `fxBitcrushCurve(bitDepth)` builds a
  stair-step transfer curve that quantizes amplitude to `2^bitDepth`
  discrete levels, crossfaded against the dry signal with the usual
  dry/wet curve (`schedulePhaserSweep`). Bit depth (1–16, default 4) is a
  per-clip slider — lower values sound more crushed/lo-fi. Sample-rate
  reduction (the other classic bitcrusher knob, which needs a custom
  `AudioWorkletProcessor` since Web Audio has no built-in downsampler)
  isn't built yet.

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

Text elements need the same `--fx-curve-unsquish` correction as the
circular markers, but can't use the same mechanism: the circles get it
via a CSS `transform-box: fill-box`, which computes the scale's pivot
from the element's own rendered bounding box. That's reliable for a
circle, but WebKit has real bugs combining `fill-box` with
`dominant-baseline` (used to vertically center the value-axis labels on
their gridline) on SVG text specifically — confirmed on a real iPhone,
where the tick labels rendered as overlapping, misaligned mess despite
looking perfectly clean in Chromium the whole time it was being built,
which is exactly how it went unnoticed until then. `fxCurveUnsquishAttr`
sidesteps bounding-box computation entirely: it sets an explicit SVG
`transform` attribute, `translate(px,py) scale(unsquish,1)
translate(-px,-py)`, pivoting on the label's own known anchor
coordinate (so it inherently stays flush against its tick, no
bounding-box agreement between browsers required) rather than an
implicitly-computed one. The vertical centering that used
`dominant-baseline="middle"` was replaced the same way, with a manual
baseline offset (`y + FX_CURVE_LABEL_FONT_SIZE * 0.32`) instead — the
same technique many chart libraries use to avoid `dominant-baseline`
cross-browser inconsistency altogether. `fxCurveUnsquishValue` mirrors
the CSS custom property as a plain number so text has something to bake
into that attribute at draw time (rather than reading it live like the
circles do), and `updateFxCurveUnsquish` now also re-runs
`drawFxCurveGrid` on resize so text doesn't fall out of sync with a
value it can't just read live off the CSS var.

**A standard EQ frequency axis for filter sweeps.** The stored curve is
always "0 = neutral, 1 = full effect" — that's what the audio math
reads, and it never changes. What changes per effect is what a given
fraction *means* on screen, via `toDisplayV`/`fromDisplayV`, the one
place data crosses the editor's screen-space boundary (rendering a
node/handle/path point, and reading a dragged pointer position back
into stored data) — so `curveEditorNodes`/`clip.curve` keep meaning
exactly what they always have regardless of how differently two effects
plot.

For a filter-kind effect (High Pass, Low Pass — checked via `cfg.kind
=== "filter"`, not merely whether `fromHz`/`toHz` exist, since washout
has both but isn't "EQ-based" the way these two are), the fraction
first converts to an actual Hz value off that effect's own `fromHz`/
`toHz`, then that Hz value plots against a **fixed 20Hz–20000Hz log
scale** (`fxFreqToAxisFrac`/`fxAxisFracToFreq`, `FX_FREQ_AXIS_MIN/MAX`)
— the same range and the same standard decade tick marks (20/100/1k/
10k/20k, `FX_FREQ_AXIS_TICKS`) an EQ's frequency response is normally
plotted against, not whatever fraction of *this specific filter's own
sweep* a gridline happens to sit at. An earlier version did the latter
— fixed 25/50/75% positions, each labeled with whatever Hz value it
happened to correspond to — which was technically accurate but produced
numbers with no relationship to anything a musician would recognize
(105Hz, 548Hz, 2.9kHz for High Pass), the "somewhat random feeling
numbers" a real EQ never shows.

Going through a real Hz value first, rather than plotting the raw
fraction directly, also fixed the earlier display-inversion problem for
free, with no separate logic needed: Low Pass's cutoff *falls* as the
effect ramps in (20000Hz → 20Hz) while High Pass's *rises* (20Hz →
15000Hz), and converting each through the same fixed frequency scale
naturally plots a falling sweep as a falling line and a rising one as a
rising line — the earlier version needed a dedicated `curveEditorInverted`
flag and a manual `1 - v` flip to fake that same result by plotting the
raw fraction upside-down for Low Pass specifically; now it's just what
"convert to Hz, then plot the Hz" does on its own for either direction.
One visible consequence worth knowing: a filter's peak no longer
necessarily reaches the very top or bottom of the graph — High Pass's
15000Hz peak sits just short of the 20000Hz scale ceiling, which is
correct, not a bug, since the graph is a real, shared frequency axis
now rather than one stretched to fill the frame for whatever range a
given filter happens to sweep. Low Pass's own range is exactly
20–20000Hz, so its curve still spans the full height, unchanged.

Every other effect (phaser/washout/echo's dry/wet mix) has no frequency
to convert through, so `toDisplayV`/`fromDisplayV` are the identity
function there, and the axis stays the fixed 25/50/75% percentage grid
it always was. Existing saved curves for any effect are unaffected
audibly either way — this is a pure presentation-layer change, not a
data migration.

Delete already worked for FX clips before this curve editor existed (the
inspector's shared duplicate/delete icons are generic across all three
lanes) — it just wasn't obvious it was there, which is part of why this
whole panel exists.

### Secondary controls

Not every constant on an `FX_EFFECTS` entry belongs on the curve — the
curve is one shaped 0..1 envelope, and some params (the phaser's LFO
rate, say) are just a fixed number with no time dimension to sweep at
all. Those get declared in a `params` array on the effect's `FX_EFFECTS`
entry and rendered in `#fxParamControls`, directly beneath the graph.
`fxParamValue(clip, cfg, key)` is every audio-side consumer's one
lookup — `clip.params[key]` if the user's touched that control, else
`cfg[key]` — the same "preview the default until an actual edit
happens" pattern `clip.curve` already uses, so merely opening the
inspector never silently writes anything. Currently: the phaser's LFO
rate (0.05–5Hz) and allpass center frequency (200–2000Hz — LFO *depth*,
±600Hz, stays a constant for now, not exposed), Echo Throw's
feedback (0–0.85, capped there rather than the >0.9 territory that
starts risking runaway buildup) and delay time, tremolo and auto-pan's
LFO rate (0.5–20Hz and 0.1–10Hz respectively — the two don't share a
slider range since a musically useful pan sweep reads much slower than
a musically useful amplitude flutter), and the bitcrusher's bit depth
(1–16, integer steps).

Two control types exist, picked per param, not by a fixed rule — a
plain numeric range (a rate, a depth, a feedback amount) is a slider
(`buildFxSliderRow`); a bounded set of musically-meaningful choices is
buttons instead (`buildFxStepsRow`, `type: "steps"` on the param), since
a continuous slider there would mostly land on values nobody would
deliberately choose. Echo Throw's delay time is exactly that case: note
divisions (1/16 through 1/2, including dotted values — `1/8.` is the
standard shorthand for 1.5× the plain note's duration) rather than a
raw seconds value, matching how real delay plugins expose this control.
Both types share `fxParamValue` and land in the same `clip.params`
object; only the input widget and event wiring differ (the slider needs
the volume-slider's `input`-updates-live/`change`-commits split so
dragging doesn't spam undo/redo, since it fires continuously — a button
tap is already one discrete, deliberate choice, so it just commits
immediately). `createDelay(1.5)` (not the `1` the plain code would
otherwise use) gives the longest option (a half note, 1s at the locked
120bpm) headroom below the node's actual max.

Reset (delete `clip.curve`) also deletes `clip.params`, returning every
secondary control to its effect's own default alongside the curve —
partial resets (curve back to default, sliders left wherever they were)
would leave a clip's actual sound out of sync with what "Reset" implies
it did.

### Secondary lanes + exploded stems

Two more concept-pressure-test features, both scoped as "get the
affordances and interaction model in front of Charley before he builds
the real thing" rather than a finished feature. Nothing here has been
tested against a real device yet — it's expected to change once it has.

**Secondary Vocal/Beats lanes** are real, functional audio: each of
Vocal and Beats gets an accordion toggle (the rotating chevron in its
row-label, `vocalExpanded`/`beatsExpanded`) that reveals a second lane —
`clips.vocal2`/`clips.beats2`, their own arrays — for layering a second
section (a doubled harmony, an alternate take) over the primary one.
The secondary lane is freeform-positioned like FX rather than
flush-packed, but capped at exactly one clip at a time (no stacking) —
`singleSlotExceedsCap` is FX's `fxExceedsMaxLayers` with the cap fixed
at 1 instead of `MAX_FX_LAYERS`. `isFreeformTrack` now covers `"fx"`,
`"vocal2"`, `"beats2"`, and `"stem"` (below) everywhere the code used to
special-case `clip.track === "fx"` alone to mean "not flush-packed."

Every vocal-family clip (`vocal` or `vocal2`) and beats-family clip
(`beats` or `beats2`) also carries `.audioTrack` ("vocal" or "beats") —
the literal stem identity used for buffer lookups, `scheduleVocal`/
`scheduleBeats` dispatch, and CSS coloring. `.track` itself answers "which
array/lane is this clip in," not "which real stem is it" — the split
matters because `song._matched.buffers` only ever has two keys
(`vocal`/`beats`), and a `vocal2` clip still needs to find the real
`vocal` one. Both the live playback and offline export loops
(`playScheduled`, `renderArrangement`) simply spread all four arrays
together before scheduling — already-overlap-safe, since every clip
there is scheduled independently off its own `.position`/`.duration`
regardless of which array it came from, so a second lane playing
simultaneously with the first needed zero audio-engine changes.

**Exploded stems** are UI-only — a `row-explode-btn` on the Beats row
(primary and secondary both have one, but only one lane can be exploded
at a time, `explodedLane`: `0`, `1`, or `null`, its icon a single line on
the left branching into three on the right) swaps that lane's single row
for six fixed sub-lanes (Drums/Bass/Guitar/Keys/Synths/Other,
`STEM_KEYS`), each holding one placeholder clip per real clip currently
in that Beats lane. They're fully interactive — move/trim/duplicate/
delete all reuse the same generic clip machinery every other clip uses
— but live in their own `clips.stem` array (one array for all six
instruments and both possible exploded lanes at once, disambiguated by
`.stemKey`/`.stemLane`) that the audio engine never reads: `clips.stem`
never appears in either scheduling spread, so nothing here can affect
actual playback or export, which is deliberately as far as this pass
goes. The inspector shows a "Preview only" hint on a selected stem clip
so that's not a surprise while poking at one.

`syncStemClipsFor` keeps that mirror live rather than generating it once
and letting it go stale — the first version only ran at explode-time,
so adding, trimming, or deleting a real Beats clip *after* opening the
exploded view left it showing the old snapshot (reported: the real
section's length not matching the exploded stems', and a newly-added
section missing from the breakdown entirely). It's called fresh on every
`renderClips()` instead, reconciled against the real lane by each stem
clip's `.sourceUid`: new source clips get their six mirrors generated,
deleted ones' mirrors are removed, and still-existing ones' position/
duration are kept pinned to their source's current values. The one
exception is `.manuallyAdjusted` — set the moment a user actually drags,
trims, or duplicates a stem clip themselves, which exempts it from both
the position-pinning and the delete-on-source-removed cleanup from then
on, since at that point it reads as the user's own creation rather than
a live mirror of something else.

The reverse direction matters too: a manually-extended stem can reach
past its own source clip's right edge, and when it does, `syncStemClipsFor`
grows the real Beats clip's `.duration` to cover it (never shrinks, never
moves the start) — "the instrumental section" should honestly represent
what's inside its own breakdown, not have a stem quietly overhanging the
section it's supposedly part of. Beats is flush-packed, so a source clip
growing calls `layout()` afterward the same as any other trim would, to
reflow whatever comes after it rather than silently starting an overlap.
That growth then also carries into every *other*, untouched stem tied to
that same source clip (they're still pinned to its current duration),
so extending one instrument doesn't leave its neighbors newly out of sync.

Because that growth changes what the real clip actually plays without
changing what it visually promised before, a real Beats/Beats2 clip gets
a yellow outline (`.stem-edited`, an `outline` rather than
`border`/`box-shadow` so it layers over `.selected`'s own styling instead
of fighting it) whenever any of its stem mirrors carry
`.manuallyAdjusted` — checked directly off `clips.stem` by `.sourceUid`
in `buildClipEl`, so it's visible on the real clip regardless of whether
its lane happens to be exploded right now. The point is specifically for
*after* collapsing the exploded view: the mismatch between "what this
section looks like" and "what's actually been rearranged inside it"
shouldn't require reopening the breakdown to notice.

**A collapsed secondary lane still contributes real audio**, which
otherwise made it disappear entirely from view -- a thin presence strip
(`renderSecondaryIndicator`, one unlabeled segment per clip, same idea as
the FX row) now sits directly under the primary Vocal/Beats row whenever
its secondary lane has content and is currently collapsed, so "there's
sound coming from somewhere I can't see" can't happen silently. It hides
itself again once the secondary lane is either empty or already visible
(its own row already shows the same clips directly).

Screen space is the real open question here, flagged but intentionally
not solved yet: Vocal + Vocal2 + Beats exploded into six rows + Beats2 +
FX is a lot of simultaneous rows on a phone screen, and the honest
answer right now is "the page just gets longer, scroll more" (see
"Mobile embed scrolling" below) rather than anything smarter. Likely a
first thing to revisit once this is actually being used.

### Mobile embed scrolling

The Webflow embed (see the note at the top of this file) uses a bare
`<iframe>`, which never auto-sizes to its content on its own. `.embedded`
in style.css (set by a snippet in `index.html` that checks
`window.self !== window.top`) drops the standalone page's pinned-shell
layout in favor of one natural page height, and a `ResizeObserver` in
main.js reports that height to the parent window on every layout change
(`tuttii-embed-resize`) so the iframe can match it exactly — no fixed-size
iframe either clipping a long library short or leaving a dead-space gap
under a short one.

That created a real bug on mobile: with nothing bounding it, a long FX
library just kept pushing the whole page taller, and scrolling down to
reach an item near the bottom of the list scrolled the timeline — the
actual drag-and-drop target — off the top of the screen with it, since
timeline and library share the same page-level scroll in embedded mode.
Fixed by giving `#songLibrary` its own `max-height` (380px) and
`overflow-y: auto` in embedded mode only — the library list scrolls
independently within that bounded box, same as the standalone page's
`.app-scroll` already does, while the timeline above it never moves.
Short lists aren't affected (`max-height` only clips overflow, it doesn't
force the box to that height), and the drag/drop gesture (`startChipDrag`
in main.js) already worked entirely off `document.elementFromPoint` and
viewport coordinates from `pointermove`/`pointerup`, so nesting the drag
source in its own scroll container needed no changes there.

The 380px figure is a fixed pixel value, deliberately not a `vh`/`dvh`
unit: since the iframe's own height is *itself* derived from this page's
reported `scrollHeight`, a viewport-relative cap here would be measuring
against a number that the cap itself helps determine, feeding back into
the resize loop above in a way that's needlessly hard to reason about.
A fixed px has no such dependency.

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
