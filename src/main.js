(function () {
  "use strict";

  // ---------- Timing model ----------
  // Everything positional (clip.position, clip.duration, playheadPos) is in BARS.
  // Bars convert to seconds only for audio scheduling, using the locked
  // project tempo -- every song's "matched" audio is pre-rendered to this
  // same BPM/key, so the whole timeline can share one BAR_SECONDS constant.
  const PROJECT_BPM = 120;
  const PROJECT_KEY = "G# maj";
  const BAR_SECONDS = (60 / PROJECT_BPM) * 4; // 4/4 time -> 2s per bar
  const BASE_BAR_PX = 28;
  const MIN_BAR_PX = BASE_BAR_PX * 0.5;
  const MAX_BAR_PX = BASE_BAR_PX * 2;
  // Mutable: pinch-to-zoom (mobile only) rescales this. Starts at the
  // fully-zoomed-out floor (not BASE_BAR_PX) per request -- same min/max
  // range as before, just a denser default so more of an arrangement is
  // visible without zooming at all; pinching in still goes up to
  // MAX_BAR_PX, and back out only as far as this same floor.
  let BAR_PX = MIN_BAR_PX;
  const TOTAL_BARS = 32;
  const MIN_DUR_BARS = 1;
  const MAX_FX_LAYERS = 4; // arbitrary cap on how many FX clips can stack at once, for v1
  const FX_SUBLANE_PX = 18; // height of one stacked FX row (matches the original single-row height)
  const FX_LAYER_SWAP_THRESHOLD_PX = 10; // how far a vertical drag on an FX clip has to travel before it's read as "reorder the stack" rather than noise

  // Stem paths below are plain relative paths (no leading slash) on purpose:
  // fetch() resolves them against the page's own URL, so the same files
  // load correctly whether this is served from a domain root, a GitHub
  // Pages project subpath, or opened straight from the repo -- no build
  // step or base-path config required.
  function audioUrl(path) { return path; }

  function barsToSeconds(b) { return b * BAR_SECONDS; }
  function barsToPx(b) { return b * BAR_PX; }
  function pxToBars(px) { return px / BAR_PX; }
  function snap(bars, step) { return Math.max(0, Math.round(bars / step) * step); }
  function roundStep(v, step) { return Math.round(v / step) * step; } // signed, no floor-at-zero

  // The single source of truth for position: always the running total of
  // everything before it in the track's order. Nothing ever sets .position
  // directly anymore — call this after any change to a track's order or
  // durations, and gaps/overlaps become structurally impossible.
  function layout(type) {
    let pos = 0;
    clips[type].forEach(c => { c.position = pos; pos += c.duration; });
  }

  // FX clips don't use layout() -- unlike Vocal/Beats, they're positioned
  // freely anywhere on the timeline (snapped to the nearest bar) rather than
  // always flush-packed against their neighbors.
  //
  // They CAN overlap now (layering) -- each FX clip gets its own dedicated
  // filter node, chained in series with every other FX clip's node ordered
  // by .layer (lower layer = higher priority = earlier in the chain =
  // visually closer to the top of the FX lane), so two overlapping clips
  // just both apply during their shared window. The only guardrail left is
  // a cap on how many can stack at once (MAX_FX_LAYERS), both to keep the
  // lane's height sane and to keep the signal chain from growing unbounded.
  function fxTimeOverlap(a, b) {
    return a.position < b.position + b.duration && a.position + a.duration > b.position;
  }
  function fxOverlapCount(candidate, excludeUid) {
    return clips.fx.filter(c => c.uid !== excludeUid && fxTimeOverlap(candidate, c)).length;
  }
  function fxExceedsMaxLayers(candidate, excludeUid) {
    return fxOverlapCount(candidate, excludeUid) >= MAX_FX_LAYERS;
  }
  // A clip's visual row: how many higher-priority (lower .layer) clips
  // currently overlap it in time. Since .layer is a total order across
  // every FX clip (see allocateTopFxLayer), this needs no separate
  // sweep-line pass -- it's recomputed fresh on every render, so the lane
  // only grows where clips actually coexist, not just because many exist.
  function fxSlotFor(clip) {
    return clips.fx.filter(c => c.uid !== clip.uid && c.layer < clip.layer && fxTimeOverlap(c, clip)).length;
  }
  // New/duplicated FX clips always land on top (processed first), per the
  // "new layers go on top" convention -- a monotonically decreasing
  // allocator guarantees that without ever renumbering existing clips.
  let nextFxLayer = 0;
  function allocateTopFxLayer() { return --nextFxLayer; }
  // Swaps a clip's stacking priority with whichever FX clip it currently
  // overlaps that's immediately next in the given direction (-1 = toward
  // the top/higher priority, +1 = toward the bottom). No-ops if nothing
  // overlaps it on that side -- there's nothing to reorder against.
  function swapFxLayer(clip, direction) {
    const candidates = clips.fx.filter(c => c.uid !== clip.uid && fxTimeOverlap(c, clip) &&
      (direction < 0 ? c.layer < clip.layer : c.layer > clip.layer));
    if (!candidates.length) return;
    const neighbor = candidates.reduce((best, c) =>
      (direction < 0 ? c.layer > best.layer : c.layer < best.layer) ? c : best);
    const tmp = clip.layer;
    clip.layer = neighbor.layer;
    neighbor.layer = tmp;
  }

  // ---------- Song / section data ----------
  // Sections are stem-agnostic, matching the real app: a section carries a vocal root
  // pitch (for when it's dropped as a vocal) and works generically as a beat pattern
  // (for when it's dropped as beats). Which stem you get is decided entirely by which
  // lane it lands in, not by anything in this data.
  // Silence isn't tied to a song — it's a deliberate rest, droppable into
  // either lane just like a section, but it produces no audio.
  const SILENCE_OPTIONS = [
    { id: "sil-1", label: "Silence", durBars: 1, isSilence: true },
    { id: "sil-2", label: "Silence", durBars: 2, isSilence: true },
    { id: "sil-4", label: "Silence", durBars: 4, isSilence: true },
    { id: "sil-8", label: "Silence", durBars: 8, isSilence: true },
    { id: "sil-16", label: "Silence", durBars: 16, isSilence: true },
  ];

  const SONGS = [
    // Real audio: a continuous native-tempo stem pair for library preview,
    // plus a second pair already time/pitch-matched to the locked project
    // BPM/key for timeline playback. See the derivation pass just below --
    // durBars and the matched-timeline timestamps are both computed from
    // these native measurements, not stored separately.
    {
      id: "bwy", name: "Be With You", artist: "Duke Dylan",
      thumbColor: "linear-gradient(135deg, #FDBB2D, #FF6B6B)", thumbIcon: "🎧",
      thumbImage: audioUrl("audio/be-with-you/cover.png"),
      isReal: true, folder: "be-with-you",
      nativeBpm: 117, nativeKey: "A maj",
      stems: {
        matched: { vocal: audioUrl("audio/be-with-you/matched-vocal.mp3"), beats: audioUrl("audio/be-with-you/matched-instrumental.mp3") },
      },
      sections: [
        { id: "bwy-1",  label: "Intro 1",      nativeStart: 1.026,   nativeEnd: 17.436 },
        { id: "bwy-2",  label: "Verse 1",      nativeStart: 17.436,  nativeEnd: 33.846 },
        { id: "bwy-3",  label: "Pre-Chorus 1", nativeStart: 33.846,  nativeEnd: 42.051 },
        { id: "bwy-4",  label: "Chorus 1",     nativeStart: 42.051,  nativeEnd: 58.462 },
        { id: "bwy-5",  label: "Build 1",      nativeStart: 58.462,  nativeEnd: 74.872 },
        { id: "bwy-6",  label: "Drop 1",       nativeStart: 74.872,  nativeEnd: 91.282 },
        { id: "bwy-7",  label: "Verse 2",      nativeStart: 91.282,  nativeEnd: 107.692 },
        { id: "bwy-8",  label: "Pre-Chorus 2", nativeStart: 107.692, nativeEnd: 115.897 },
        { id: "bwy-9",  label: "Chorus 2",     nativeStart: 115.897, nativeEnd: 132.308 },
        { id: "bwy-10", label: "Build 2",      nativeStart: 132.308, nativeEnd: 148.718 },
        { id: "bwy-11", label: "Drop 2",       nativeStart: 148.718, nativeEnd: 165.128 },
        { id: "bwy-12", label: "Drop 3",       nativeStart: 165.128, nativeEnd: 181.538 },
        { id: "bwy-13", label: "Outro 1",      nativeStart: 181.538, nativeEnd: 197.949 },
      ],
      // Native (preview) and matched (timeline) stem pairs load independently --
      // native is small and prefetched in the background from page load, so
      // Preview no longer touches these -- each section has its own tiny
      // pre-sliced preview file (see SECTION_PREVIEW below), so nothing
      // whole-song needs to load before a section can be tapped. Matched
      // still loads as one pair, lazily, on first actual drop.
      _matched: { state: "idle", buffers: null, promise: null },
    },
    {
      id: "sl", name: "Smoker Lungs", artist: "Zachary Scott Kline",
      thumbColor: "linear-gradient(135deg, #6B7280, #1F2937)", thumbIcon: "🌫️",
      thumbImage: audioUrl("audio/smoker-lungs/cover.jpg"),
      isReal: true, folder: "smoker-lungs",
      nativeBpm: 127, nativeKey: "G maj",
      stems: {
        matched: { vocal: audioUrl("audio/smoker-lungs/matched-vocal.mp3"), beats: audioUrl("audio/smoker-lungs/matched-instrumental.mp3") },
      },
      sections: [
        { id: "sl-1", label: "Intro 1",        nativeStart: 2.805,   nativeEnd: 17.923 },
        { id: "sl-2", label: "Verse 1",        nativeStart: 17.923,  nativeEnd: 48.159 },
        { id: "sl-3", label: "Chorus 1",       nativeStart: 48.159,  nativeEnd: 78.396 },
        { id: "sl-4", label: "Post-Chorus 1",  nativeStart: 78.396,  nativeEnd: 82.175 },
        { id: "sl-5", label: "Verse 2",        nativeStart: 82.175,  nativeEnd: 112.411 },
        { id: "sl-6", label: "Chorus 2",       nativeStart: 112.411, nativeEnd: 150.207 },
        { id: "sl-7", label: "Outro 1",        nativeStart: 150.207, nativeEnd: 165.325 },
      ],
      _matched: { state: "idle", buffers: null, promise: null },
    },
    {
      id: "dyr", name: "Do You Remember", artist: "waitwhat",
      thumbColor: "linear-gradient(135deg, #4FD1E8, #E84BC6)", thumbIcon: "🌙",
      thumbImage: audioUrl("audio/do-you-remember/cover.png"),
      isReal: true, folder: "do-you-remember",
      nativeBpm: 122, nativeKey: "G# maj",
      stems: {
        matched: { vocal: audioUrl("audio/do-you-remember/matched-vocal.mp3"), beats: audioUrl("audio/do-you-remember/matched-instrumental.mp3") },
      },
      sections: [
        { id: "dyr-1",  label: "Intro 1",      nativeStart: 1.967,   nativeEnd: 5.902 },
        { id: "dyr-2",  label: "Verse 1",      nativeStart: 5.902,   nativeEnd: 21.639 },
        { id: "dyr-3",  label: "Pre-Chorus 1", nativeStart: 21.639,  nativeEnd: 37.377 },
        { id: "dyr-4",  label: "Chorus 1",     nativeStart: 37.377,  nativeEnd: 53.115 },
        { id: "dyr-5",  label: "Drop 1",       nativeStart: 53.115,  nativeEnd: 68.852 },
        { id: "dyr-6",  label: "Verse 2",      nativeStart: 68.852,  nativeEnd: 84.590 },
        { id: "dyr-7",  label: "Pre-Chorus 2", nativeStart: 84.590,  nativeEnd: 100.328 },
        { id: "dyr-8",  label: "Chorus 2",     nativeStart: 100.328, nativeEnd: 116.066 },
        { id: "dyr-9",  label: "Drop 2",       nativeStart: 116.066, nativeEnd: 131.803 },
        { id: "dyr-10", label: "Drop 3",       nativeStart: 131.803, nativeEnd: 147.541 },
        { id: "dyr-11", label: "Outro 1",      nativeStart: 147.541, nativeEnd: 151.475 },
      ],
      _matched: { state: "idle", buffers: null, promise: null },
    },
  ];

  // A correct time-stretch preserves bar structure, so a real song's
  // section boundaries only ever need to be measured once, against its
  // native file -- durBars and the matched-timeline timestamps are both
  // derived here from that single measurement plus the tempo ratio.
  SONGS.forEach(song => {
    if (!song.isReal) return;
    const nativeBarSeconds = (60 / song.nativeBpm) * 4;
    const scale = song.nativeBpm / PROJECT_BPM;
    song.sections.forEach(sec => {
      sec.songId = song.id;
      sec.durBars = Math.round((sec.nativeEnd - sec.nativeStart) / nativeBarSeconds);
      sec.matchedStart = +(sec.nativeStart * scale).toFixed(3);
      sec.matchedEnd = +(sec.nativeEnd * scale).toFixed(3);
    });
  });

  // clip: {uid, track, label, songName, root, position(bars), duration(bars), volume}
  // fx clips carry no songName/root -- just {effectId}, and automate the
  // shared master filter (see FX_EFFECTS + scheduleFxClip) instead of
  // producing their own sound.
  let clips = { vocal: [], beats: [], fx: [] };
  let uidCounter = 1;
  let selectedUid = null;

  // ---------- FX ----------
  // One row per effect type in the library (tap-to-expand, same pattern as
  // Songs); durationsBars are the preset lengths offered as draggable
  // chips. `kind` selects which shape buildFxUnit builds:
  //  - "filter" (default, no kind needed): one BiquadFilterNode, its cutoff
  //    swept fromHz -> toHz over the clip's curve. fromHz doubles as
  //    neutral, since every curve here starts and ends at value 0.
  //  - "phaser": an allpass chain + shared LFO + dry/wet crossfade (see
  //    buildFxUnit); fromWet/toWet describe the crossfade the same way
  //    fromHz/toHz do for a filter. centerHz/lfoRateHz/lfoDepthHz/stages
  //    are fixed characteristics of the effect for now, not curve-controlled.
  //  - "washout": a synthetic-impulse reverb (dry/wet, fromWet/toWet) whose
  //    combined output also passes through a highpass (fromHz/toHz) -- both
  //    driven by the same curve, reusing schedulePhaserSweep and
  //    scheduleFxSweep unmodified rather than inventing new curve math.
  //  - "echo": a feedback delay (fixed delaySec/feedback) crossfaded in via
  //    the same dry/wet curve as phaser/washout (fromWet/toWet).
  const FX_EFFECTS = [
    { id: "highpass", label: "High Pass", icon: "📈", durationsBars: [2, 4, 8, 16],
      kind: "filter", filterType: "highpass", fromHz: 20, toHz: 15000 },
    { id: "lowpass", label: "Low Pass", icon: "📉", durationsBars: [2, 4, 8, 16],
      kind: "filter", filterType: "lowpass", fromHz: 20000, toHz: 20 },
    { id: "phaser", label: "Phaser", icon: "🌀", durationsBars: [2, 4, 8, 16],
      kind: "phaser", stages: 6, centerHz: 800, lfoRateHz: 0.3, lfoDepthHz: 600,
      fromWet: 0, toWet: 1 },
    { id: "washout", label: "Washout", icon: "🌊", durationsBars: [2, 4, 8, 16],
      kind: "washout", fromHz: 20, toHz: 300, fromWet: 0, toWet: 1 },
    { id: "echo-throw", label: "Echo Throw", icon: "🔁", durationsBars: [2, 4, 8, 16],
      kind: "echo", delaySec: BAR_SECONDS / 8, feedback: 0.45, fromWet: 0, toWet: 1 },
  ];
  function fxEffectFor(effectId) { return FX_EFFECTS.find(e => e.id === effectId); }

  // ---------- Analytics ----------
  // Fires once per page load, the first time the user does something that
  // signals real engagement (drops a section on the timeline, or gets
  // playback going) rather than just landing on /try and reading.
  let interactionStarted = false;

  // GTM only runs in the parent page, not in this iframe, so a local
  // dataLayer.push() here would land in an isolated, unread dataLayer —
  // same postMessage bridge already used for tuttii-embed-resize/-scroll.
  function pushAnalyticsEvent(eventName) {
    window.parent.postMessage({ type: "tuttii-embed-analytics", event: eventName }, "*");
  }

  function trackFirstInteraction() {
    if (interactionStarted) return;
    interactionStarted = true;
    pushAnalyticsEvent("demo_interaction_started");
  }

  // Only Songs/Silence/FX are top-level tabs -- what used to be separate
  // Vocals/Inst tabs is now a sub-tab under Songs (songPreviewMode) that
  // only changes what tapping a section previews (both stems / vocal only
  // / beats only); dragging into a lane is unaffected by either. Silence
  // and FX are flat lists, not part of the song browsing at all.
  let activeLibraryTab = "songs";
  let songPreviewMode = "original";
  // At most one song's sections are exposed at a time -- expanding a
  // different song collapses whichever one was open.
  let expandedSongId = null;
  // Same idea, for the FX tab's effect-type rows.
  let expandedFxId = null;

  let audioCtx = null;
  let audioUnlocked = false;
  let isPlaying = false;
  let playStartCtxTime = 0;
  let playStartBar = 0;
  let playheadBar = 0;
  let scheduledNodes = [];
  let rafId = null;
  let masterOutCache = null; // { el } -- see ensureSilentLoop() below

  let history = [];
  let historyIndex = -1;

  // ---------- DOM refs ----------
  const scrollArea = document.getElementById("scrollArea");
  const scrollInner = document.getElementById("scrollInner");
  const vocalRow = document.getElementById("vocalRow");
  const beatsRow = document.getElementById("beatsRow");
  const vocalLane = document.getElementById("vocalLane");
  const beatsLane = document.getElementById("beatsLane");
  const fxRow = document.getElementById("fxRow");
  const fxLane = document.getElementById("fxLane");
  const vocalEmpty = document.getElementById("vocalEmpty");
  const beatsEmpty = document.getElementById("beatsEmpty");
  const fxEmpty = document.getElementById("fxEmpty");
  const scrubLane = document.getElementById("scrubLane");
  const playhead = document.getElementById("playhead");
  const timeCur = document.getElementById("timeCur");
  const timeTotal = document.getElementById("timeTotal");
  const playBtn = document.getElementById("playBtn");
  const playIcon = document.getElementById("playIcon");
  const skipStartBtn = document.getElementById("skipStartBtn");
  const rewindBtn = document.getElementById("rewindBtn");
  const fastFwdBtn = document.getElementById("fastFwdBtn");
  const locateBtn = document.getElementById("locateBtn");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const resetBtn = document.getElementById("resetBtn");
  const inspector = document.getElementById("inspector");
  const closeInsp = document.getElementById("closeInsp");
  const duplicateClipBtn = document.getElementById("duplicateClip");
  const deleteClipBtn = document.getElementById("deleteClip");
  const volSlider = document.getElementById("volSlider");
  const volVal = document.getElementById("volVal");
  const fxCurveSvg = document.getElementById("fxCurveSvg");
  const fxCurvePath = document.getElementById("fxCurvePath");
  const fxCurveGridGroup = document.getElementById("fxCurveGridGroup");
  const fxCurveSegHandlesGroup = document.getElementById("fxCurveSegHandlesGroup");
  const fxCurveNodesGroup = document.getElementById("fxCurveNodesGroup");
  const fxCurveAddNode = document.getElementById("fxCurveAddNode");
  const fxCurveDeleteNode = document.getElementById("fxCurveDeleteNode");
  const fxCurveReset = document.getElementById("fxCurveReset");
  const songLibrary = document.getElementById("songLibrary");
  const libraryTabs = document.getElementById("libraryTabs");
  const librarySubtabs = document.getElementById("librarySubtabs");
  const exportWavBtn = document.getElementById("exportWavBtn");
  const exportMp3Btn = document.getElementById("exportMp3Btn");
  const titleInput = document.getElementById("titleInput");
  const errBanner = document.getElementById("errBanner");

  function showJsError(msg) {
    errBanner.textContent = "Something broke: " + msg + " — tap to dismiss.";
    errBanner.style.display = "block";
  }
  errBanner.addEventListener("click", () => { errBanner.style.display = "none"; });
  window.addEventListener("error", (e) => showJsError(e.message + " (line " + e.lineno + ")"));
  window.addEventListener("unhandledrejection", (e) => showJsError(String(e.reason)));

  const LABEL_W = 66;

  // Scrolls the timeline just enough to bring a clip fully into view, if it
  // isn't already — used after a drop or duplicate so a new clip landing
  // outside the visible area doesn't look like nothing happened.
  function scrollClipIntoView(clip) {
    const clipLeft = LABEL_W + barsToPx(clip.position);
    const clipRight = clipLeft + barsToPx(clip.duration);
    const viewLeft = scrollArea.scrollLeft;
    const viewRight = viewLeft + scrollArea.clientWidth;
    if (clipLeft >= viewLeft && clipRight <= viewRight) return; // already fully visible
    const target = clipRight > viewRight
      ? clipRight - scrollArea.clientWidth + 16
      : clipLeft - 16;
    scrollArea.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }

  // ---------- Build bar grid + ruler ----------
  // Lane/scrub widths and every grid line's position are all derived from
  // BAR_PX, so this whole thing is torn down and rebuilt on zoom (pinch),
  // not just built once -- these are static inline styles computed at
  // build time, not recalculated per-render like clips/playhead are.
  function buildTimelineGrid() {
    vocalLane.querySelectorAll(".bar-line").forEach(el => el.remove());
    beatsLane.querySelectorAll(".bar-line").forEach(el => el.remove());
    fxLane.querySelectorAll(".bar-line").forEach(el => el.remove());
    scrubLane.querySelectorAll(".scrub-tick").forEach(el => el.remove());

    const contentWidth = barsToPx(TOTAL_BARS);
    scrollInner.style.width = (LABEL_W + contentWidth) + "px";
    [vocalLane, beatsLane, fxLane, scrubLane].forEach(el => { el.style.width = contentWidth + "px"; });

    for (let b = 0; b < TOTAL_BARS; b++) {
      [vocalLane, beatsLane, fxLane].forEach(lane => {
        const gl = document.createElement("div");
        gl.className = "bar-line" + (b % 4 === 0 ? " major" : "");
        gl.style.left = barsToPx(b) + "px";
        lane.appendChild(gl);
      });
      if (b % 4 === 0) {
        const tick = document.createElement("div");
        tick.className = "scrub-tick";
        tick.style.left = barsToPx(b) + "px";
        tick.textContent = (b + 1);
        scrubLane.appendChild(tick);
      }
    }
  }
  buildTimelineGrid();

  // ---------- Pinch-to-zoom (mobile timeline only) ----------
  // Mouse/pen pointers never enter this at all (gated on pointerType
  // "touch" below), so desktop is completely unaffected. Scoped to
  // scrollArea's own subtree, which is also how it naturally never
  // interferes with the library's chip-row dragging elsewhere on the page.
  //
  // The trickier part isn't the zoom math, it's that a pinch's first finger
  // can easily land on a clip, a trim handle, or the scrub row and already
  // be mid-gesture (move/trim/seek) by the time the second finger arrives.
  // Each of those three gesture-starters registers a cancelActiveGesture
  // callback for exactly this handoff -- when the second touch lands, it's
  // called once (detaching that gesture's listeners without committing
  // anything) before pinch tracking takes over.
  let cancelActiveGesture = null;
  const touchPositions = new Map(); // pointerId -> {x, y}, touch pointers only
  let pinchState = null; // { startDist, startBarPx, screenOffset }

  function touchDist() {
    const pts = [...touchPositions.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  function setZoom(newBarPx, anchorClientX) {
    newBarPx = Math.max(MIN_BAR_PX, Math.min(MAX_BAR_PX, newBarPx));
    if (Math.abs(newBarPx - BAR_PX) < 0.01) return;
    const rect = scrollArea.getBoundingClientRect();
    const screenOffset = anchorClientX - rect.left; // pinch midpoint's position on screen, stable across zoom
    const anchorBars = (scrollArea.scrollLeft + screenOffset - LABEL_W) / BAR_PX; // which bar sits there right now
    BAR_PX = newBarPx;
    buildTimelineGrid();
    renderClips();
    updatePlayheadEl();
    // Keep that same bar under the same screen point, so zooming feels
    // anchored to where the fingers actually are, not the left edge.
    scrollArea.scrollLeft = Math.max(0, LABEL_W + anchorBars * BAR_PX - screenOffset);
    updateZoomButtonsDisabled();
  }

  // Desktop-only zoom buttons (see .zoom-controls' pointer:fine CSS) --
  // pinch-to-zoom is touch-only, so mouse users had no way to zoom at all.
  // Same setZoom() pinch uses; anchored on the visible timeline's center
  // rather than a pinch midpoint, since there's no finger position here.
  const ZOOM_BUTTON_FACTOR = 1.25;
  function zoomByButton(factor) {
    const rect = scrollArea.getBoundingClientRect();
    setZoom(BAR_PX * factor, rect.left + rect.width / 2);
  }
  function updateZoomButtonsDisabled() {
    zoomInBtn.disabled = BAR_PX >= MAX_BAR_PX - 0.01;
    zoomOutBtn.disabled = BAR_PX <= MIN_BAR_PX + 0.01;
  }
  zoomInBtn.addEventListener("click", () => zoomByButton(ZOOM_BUTTON_FACTOR));
  zoomOutBtn.addEventListener("click", () => zoomByButton(1 / ZOOM_BUTTON_FACTOR));
  updateZoomButtonsDisabled();

  scrollArea.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touchPositions.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPositions.size === 2) {
      e.stopPropagation(); // don't also let this 2nd touch start its own clip/handle/scrub gesture
      if (cancelActiveGesture) cancelActiveGesture();
      const pts = [...touchPositions.values()];
      pinchState = {
        startDist: touchDist(),
        startBarPx: BAR_PX,
        anchorClientX: (pts[0].x + pts[1].x) / 2,
      };
    }
  }, { capture: true });

  scrollArea.addEventListener("pointermove", (e) => {
    if (!touchPositions.has(e.pointerId)) return;
    touchPositions.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinchState || touchPositions.size !== 2) return;
    e.stopPropagation();
    const dist = touchDist();
    if (dist <= 0 || pinchState.startDist <= 0) return;
    setZoom(pinchState.startBarPx * (dist / pinchState.startDist), pinchState.anchorClientX);
  }, { capture: true });

  function endTouch(e) {
    if (!touchPositions.has(e.pointerId)) return;
    touchPositions.delete(e.pointerId);
    if (touchPositions.size < 2) pinchState = null;
  }
  scrollArea.addEventListener("pointerup", endTouch, { capture: true });
  scrollArea.addEventListener("pointercancel", endTouch, { capture: true });

  // The whole row is the scrub target — no need to hit the thin playhead line
  // exactly. Press anywhere in it and the playhead snaps to your finger, then
  // tracks it continuously as you drag, just like a normal seek bar.
  scrubLane.style.touchAction = "none";
  scrubLane.addEventListener("pointerdown", (e) => {
    const pointerId = e.pointerId;
    pause();
    document.body.style.touchAction = "none";

    function seekFromEvent(ev) {
      const rect = scrubLane.getBoundingClientRect();
      const bars = pxToBars(ev.clientX - rect.left);
      playheadBar = Math.max(0, Math.min(TOTAL_BARS, bars));
      updatePlayheadEl();
    }
    seekFromEvent(e);

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      seekFromEvent(ev);
    }
    function cleanup() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.touchAction = "";
      cancelActiveGesture = null;
    }
    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    }
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    cancelActiveGesture = cleanup;
  });

  // ---------- Library (tabbed: Songs / Silence / FX) ----------
  // songPreviewMode is stored as the actual preview mode ("vocal"/"beats")
  // except for the default, stored as "original" since that's a distinct
  // concept from "both" everywhere else it's user-facing -- but reconstructing
  // the original full mix from both stems is exactly what mode "both" means
  // to togglePreview/scheduleVocal/scheduleBeats, so this is the one place
  // that translation happens.
  function songPreviewModeToMode() {
    return songPreviewMode === "original" ? "both" : songPreviewMode;
  }

  function renderLibrary() {
    if (previewChipEl) stopPreview(); // clear any preview tied to a chip we're about to remove
    songLibrary.innerHTML = "";
    librarySubtabs.classList.toggle("show", activeLibraryTab === "songs");

    if (activeLibraryTab === "silence") {
      // No song-header banner here, unlike Songs/FX -- those rows are
      // themselves the tap-to-expand control. Silence has nothing to
      // expand (it isn't tied to a song or effect with variants to drill
      // into), so the duration chips are the only thing on this tab and
      // just show immediately.
      const silRow = document.createElement("div");
      silRow.className = "chip-row";
      SILENCE_OPTIONS.forEach(sec => silRow.appendChild(makeChip(sec, "", "both", false)));
      songLibrary.appendChild(silRow);
      return;
    }

    if (activeLibraryTab === "fx") {
      FX_EFFECTS.forEach(effect => {
        songLibrary.appendChild(
          effect.id === expandedFxId ? buildExpandedFxRow(effect) : buildFxSummaryRow(effect)
        );
      });
      return;
    }

    const mode = songPreviewModeToMode();
    SONGS.forEach(song => {
      songLibrary.appendChild(
        song.id === expandedSongId ? buildExpandedSongRow(song, mode) : buildSongSummaryRow(song)
      );
    });
  }

  // Same summary/expand pattern as a song: a row per effect type, tap to
  // reveal its duration variants in place (only one expanded at a time).
  function buildFxSummaryRow(effect) {
    const header = document.createElement("div");
    header.className = "song-header";
    header.innerHTML = `
      <div class="song-thumb fx-thumb">${effect.icon}</div>
      <div class="song-info">
        <div class="song-title">${effect.label}</div>
        <div class="song-sub">Tap to view durations</div>
      </div>
      <button class="song-expand-btn" title="View durations">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
    `;
    header.addEventListener("click", () => {
      expandedFxId = effect.id;
      renderLibrary();
    });
    return header;
  }

  function buildExpandedFxRow(effect) {
    const row = document.createElement("div");
    row.className = "chip-row";
    effect.durationsBars.forEach(dur => {
      const chip = { id: `${effect.id}-${dur}`, label: effect.label, durBars: dur, isFx: true, effectId: effect.id };
      row.appendChild(makeChip(chip, "", "both", false));
    });

    const back = document.createElement("button");
    back.className = "song-back-btn";
    back.title = "Back to " + effect.label;
    back.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>`;
    back.addEventListener("click", () => {
      expandedFxId = null;
      renderLibrary();
    });
    row.appendChild(back);
    return row;
  }

  function buildSongSummaryRow(song) {
    const header = document.createElement("div");
    header.className = "song-header";
    const thumbHtml = song.thumbImage
      ? `<img class="song-thumb" src="${song.thumbImage}" alt="" />`
      : `<div class="song-thumb" style="background:${song.thumbColor}">${song.thumbIcon}</div>`;
    header.innerHTML = `
      ${thumbHtml}
      <div class="song-info">
        <div class="song-title">${song.name}</div>
        <div class="song-sub">Tap to view sections</div>
      </div>
      <div class="song-meta">
        <div class="meta-line">${song.nativeBpm} <span class="sep">·</span> ${song.nativeKey}</div>
        <div class="segments">${song.sections.length} segments</div>
      </div>
      <div class="song-check" title="Pre-matched, ready to drag">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <button class="song-expand-btn" title="View sections">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <div class="song-match-bar"></div>
    `;
    header.addEventListener("click", () => {
      expandedSongId = song.id;
      renderLibrary();
    });
    return header;
  }

  // Replaces the song's summary row in place with its sections -- not an
  // accordion insert below it. Only one song is ever expanded at a time;
  // the back button (or expanding a different song) collapses it again.
  // Sections render immediately -- nothing whole-song has to load first,
  // since each chip loads its own tiny preview file lazily on first tap.
  function buildExpandedSongRow(song, mode) {
    const row = document.createElement("div");
    row.className = "chip-row";
    song.sections.forEach(sec => row.appendChild(makeChip(sec, song.name, mode, true)));

    const back = document.createElement("button");
    back.className = "song-back-btn";
    back.title = "Back to " + song.name;
    back.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>`;
    back.addEventListener("click", () => {
      expandedSongId = null;
      renderLibrary();
    });
    row.appendChild(back);
    return row;
  }

  // A cheap deterministic hash so each section's decorative mini-waveform
  // looks distinct but never changes across re-renders.
  function seedFromId(id) {
    let s = 0;
    for (let i = 0; i < id.length; i++) s += id.charCodeAt(i);
    return s;
  }

  function miniWaveHtml(seed) {
    let html = '<div class="chip-wave">';
    for (let i = 0; i < 14; i++) {
      const h = 3 + Math.round(Math.abs(Math.sin(i * 1.7 + seed)) * 13);
      html += `<span style="height:${h}px"></span>`;
    }
    return html + "</div>";
  }

  // `compact` sections (revealed by expanding a song) show just a bar-count
  // badge + label + decorative waveform, matching the real app; the flat
  // Silence list keeps the fuller label/duration/preview-icon chip.
  function makeChip(sec, songName, mode, compact) {
    const chip = document.createElement("div");
    chip.className = "section-chip" + (compact ? " compact" : "");
    chip.style.touchAction = "none";
    if (compact) {
      chip.innerHTML = `<span class="chip-bars">${sec.durBars}</span><span class="label">${sec.label}</span>${miniWaveHtml(seedFromId(sec.id))}`;
    } else {
      const playIconHtml = (sec.isSilence || sec.isFx) ? "" : `<span class="chip-play-icon">▶</span>`;
      chip.innerHTML = `<span class="label">${sec.label}</span>${songName ? `<span class="song">${songName}</span>` : ""}<span class="dur">${sec.durBars} bar${sec.durBars > 1 ? "s" : ""}</span>${playIconHtml}`;
    }
    chip.addEventListener("pointerdown", (e) => startChipDrag(e, sec, songName, chip, mode || "both"));
    return chip;
  }

  libraryTabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".lib-tab");
    if (!btn || btn.classList.contains("active")) return;
    activeLibraryTab = btn.dataset.tab;
    libraryTabs.querySelectorAll(".lib-tab").forEach(b => b.classList.toggle("active", b === btn));
    renderLibrary();
  });

  librarySubtabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".lib-subtab");
    if (!btn || btn.classList.contains("active")) return;
    songPreviewMode = btn.dataset.submode;
    librarySubtabs.querySelectorAll(".lib-subtab").forEach(b => b.classList.toggle("active", b === btn));
    renderLibrary(); // expandedSongId is untouched -- switching preview mode shouldn't collapse whichever song is open
  });

  // ---------- Drag-and-drop from library into timeline ----------
  // Sections carry no stem type of their own — whichever lane the chip is dropped
  // into (Vocal or Beats) decides which stem gets added. The ghost's color updates
  // live as you drag over each lane, previewing which stem you're about to place.
  function startChipDrag(e, sec, songName, chipEl, mode) {
    const startX = e.clientX, startY = e.clientY;
    const pointerId = e.pointerId;
    let dragging = false;
    let ghost = null;
    let hoverType = null;

    // Claim this touch fully, right away — don't wait for movement to decide.
    // Waiting and hoping the browser hands control back mid-gesture is exactly
    // the kind of handoff mobile Safari is unreliable about.
    document.body.style.touchAction = "none";
    const chipRow = e.currentTarget.closest(".chip-row");
    const startScrollLeft = chipRow ? chipRow.scrollLeft : 0;

    function positionGhost(x, y) {
      ghost.style.left = (x - ghost.offsetWidth / 2) + "px";
      ghost.style.top = (y - 30) + "px";
    }

    // FX chips only drop into the FX lane; everything else (songs/silence)
    // only drops into Vocal/Beats -- keeps a filter sweep from landing in
    // an audio lane or vice versa.
    function validLanesFor() {
      return sec.isFx ? [fxLane] : [vocalLane, beatsLane];
    }

    function updateHighlight(x, y) {
      [vocalLane, beatsLane, fxLane].forEach(l => l.classList.remove("drop-valid", "drop-invalid"));
      const el = document.elementFromPoint(x, y);
      const laneEl = el && el.closest(".row-lane");
      const valid = laneEl && validLanesFor().includes(laneEl);
      let type = valid ? laneEl.dataset.track : null;
      if (valid && laneEl === fxLane) {
        // FX has no flush-packing to fall back on, so give live feedback on
        // whether wherever the pointer currently is would actually stick.
        const rect = fxLane.getBoundingClientRect();
        const cursorBars = pxToBars(x - rect.left);
        const snappedPos = snap(cursorBars - sec.durBars / 2, 1);
        const tooDeep = fxExceedsMaxLayers({ position: snappedPos, duration: sec.durBars }, null);
        laneEl.classList.add(tooDeep ? "drop-invalid" : "drop-valid");
        if (tooDeep) type = null; // ghost stays neutral, not a false "fx" promise
      } else if (type) {
        laneEl.classList.add("drop-valid");
      }
      if (type !== hoverType) {
        hoverType = type;
        ghost.classList.remove("vocal", "beats", "fx", "neutral");
        ghost.classList.add(hoverType || "neutral");
      }
    }

    function clearHighlight() {
      [vocalLane, beatsLane, fxLane].forEach(l => l.classList.remove("drop-valid", "drop-invalid"));
    }

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault(); // safe unconditionally now — nothing native is relying on this gesture
      const dx = ev.clientX - startX, dy = ev.clientY - startY;

      if (!dragging) {
        if (startY - ev.clientY > 18) {
          dragging = true;
          ghost = document.createElement("div");
          ghost.className = "drag-ghost neutral";
          ghost.style.width = barsToPx(sec.durBars) + "px";
          ghost.innerHTML = `<div class="clip-name">${sec.label}</div><div class="clip-sub">${songName}</div>`;
          document.body.appendChild(ghost);
        } else {
          // Not lifted out yet — replicate the row's native horizontal scroll by hand,
          // since touch-action:none means the browser won't do it for us anymore.
          if (chipRow) chipRow.scrollLeft = startScrollLeft - dx;
          return;
        }
      }

      positionGhost(ev.clientX, ev.clientY);
      updateHighlight(ev.clientX, ev.clientY);
    }

    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.touchAction = "";
      clearHighlight();

      if (dragging) {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const lane = el && el.closest(".row-lane");
        if (lane && validLanesFor().includes(lane)) {
          const type = lane.dataset.track;
          const rect = lane.getBoundingClientRect();
          const cursorBars = pxToBars(ev.clientX - rect.left);
          dropSectionAt(sec, type, songName, cursorBars);
        }
        if (ghost) ghost.remove();
      } else {
        // A tap with no meaningful movement — preview this section instead
        // of placing it. Silence and FX have nothing to preview.
        if (!sec.isSilence && !sec.isFx) togglePreview(sec, chipEl, mode);
      }
    }

    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  // Drops a new clip using cursor position (in bars) to decide placement:
  // - Dropped past the midpoint of an existing clip -> appended right after it.
  // - Dropped before the midpoint of an existing clip -> inserted before it,
  //   pushing that clip (and anything after it) forward by exactly enough bars.
  // - Dropped in open space -> placed centered under the cursor, snapped to grid.
  // A final left-to-right pass then closes any remaining overlaps that result.
  function dropSectionAt(sec, type, songName, cursorBars) {
    const clip = {
      uid: uidCounter++,
      track: type,
      label: sec.label,
      songName: songName,
      root: sec.root || 220,
      position: 0,
      duration: sec.durBars,
      volume: 1,
      isSilence: !!sec.isSilence,
    };
    if (sec.isFx) clip.effectId = sec.effectId;
    // Real sections carry no synthesized pitch/pattern -- instead they point
    // at an offset range into the song's pre-rendered "matched" stem buffer
    // (already time/pitch-matched to the locked project BPM/key), which is
    // what actually gets scheduled for this clip everywhere on the timeline.
    if (sec.songId) {
      clip.songId = sec.songId;
      clip.sourceStart = sec.matchedStart;
      clip.sourceEnd = sec.matchedEnd;
      // Matched audio is only ever needed once something's actually placed
      // on the timeline, so it's not fetched until right now, on first use --
      // kicked off here rather than awaited, so the drop itself stays snappy;
      // scheduleRealClip() simply produces no sound for this clip until it
      // resolves (a moment, in practice, given the file sizes involved).
      // preloadMatched() is idempotent (returns the cached promise once
      // loading/loaded), so this is safe to call regardless of who actually
      // triggered the fetch -- re-rendering once it resolves is what swaps
      // this clip's waveform from the decorative placeholder to real data.
      const song = SONGS.find(s => s.id === sec.songId);
      if (song) preloadMatched(song).then(() => renderClips()).catch(() => {});
    }

    if (type === "fx") {
      // No flush-packing here -- lands wherever it's dropped, snapped to
      // the nearest bar (cursorBars is where the pointer is, and the ghost
      // is centered on the pointer, so center the clip on it too). Refuses
      // the drop outright if that would stack past MAX_FX_LAYERS, rather
      // than shoving neighbors aside. New clips always land on top.
      const snappedPos = snap(cursorBars - clip.duration / 2, 1);
      if (fxExceedsMaxLayers({ position: snappedPos, duration: clip.duration }, null)) return;
      clip.position = snappedPos;
      clip.layer = allocateTopFxLayer();
      clips.fx.push(clip);
    } else {
      const arr = clips[type];
      let insertIdx = arr.length; // default: append at the end
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (cursorBars < c.position + c.duration) {
          const midpoint = c.position + c.duration / 2;
          insertIdx = (cursorBars >= midpoint) ? i + 1 : i;
          break;
        }
      }
      arr.splice(insertIdx, 0, clip);
      layout(type);
    }

    trackFirstInteraction();
    renderClips();
    selectClip(clip.uid);
    scrollClipIntoView(clip);
    commitHistory();
  }

  // Real per-bar peak amplitude (0-1) for a buffer's [startSec, endSec)
  // window, one bar per roughly-pixel-width slot -- actual audio, so a
  // silent stretch of a vocal genuinely shows as a flat/low run of bars
  // instead of the decorative sine pattern used as a loading placeholder.
  function computeWaveformBars(buffer, startSec, endSec, barCount) {
    const sr = buffer.sampleRate;
    const ch = buffer.getChannelData(0);
    const startSample = Math.max(0, Math.floor(startSec * sr));
    const endSample = Math.min(ch.length, Math.floor(endSec * sr));
    const span = Math.max(1, endSample - startSample);
    const bars = [];
    for (let b = 0; b < barCount; b++) {
      const binStart = startSample + Math.floor((span * b) / barCount);
      const binEnd = Math.max(binStart + 1, startSample + Math.floor((span * (b + 1)) / barCount));
      const step = Math.max(1, Math.floor((binEnd - binStart) / 20)); // sparse sample within the bin
      let peak = 0;
      for (let i = binStart; i < binEnd; i += step) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
      bars.push(peak);
    }
    return bars;
  }

  // ---------- Render clips ----------
  function renderClips() {
    vocalLane.querySelectorAll(".clip").forEach(el => el.remove());
    beatsLane.querySelectorAll(".clip").forEach(el => el.remove());
    fxLane.querySelectorAll(".clip").forEach(el => el.remove());
    vocalEmpty.style.display = clips.vocal.length ? "none" : "flex";
    beatsEmpty.style.display = clips.beats.length ? "none" : "flex";
    fxEmpty.style.display = clips.fx.length ? "none" : "flex";

    clips.vocal.forEach(c => vocalLane.appendChild(buildClipEl(c)));
    clips.beats.forEach(c => beatsLane.appendChild(buildClipEl(c)));

    // FX row grows to fit however deep the stack currently gets -- only
    // where clips actually overlap in time, not just because many exist
    // (fxSlotFor is recomputed fresh from current overlaps each render).
    const maxSlot = clips.fx.length ? Math.max(...clips.fx.map(fxSlotFor)) : 0;
    const fxRowPx = (maxSlot + 1) * FX_SUBLANE_PX;
    fxRow.style.height = fxRowPx + "px";
    fxLane.style.height = fxRowPx + "px";
    clips.fx.forEach(c => fxLane.appendChild(buildClipEl(c)));

    const anyClips = clips.vocal.length > 0 || clips.beats.length > 0 || clips.fx.length > 0;
    exportWavBtn.disabled = !anyClips;
    exportMp3Btn.disabled = !anyClips;
    timeTotal.textContent = formatTime(barsToSeconds(timelineEndBars()));
  }

  function buildClipEl(clip) {
    const el = document.createElement("div");
    el.className = "clip " + clip.track + (clip.isSilence ? " silence" : "") + (clip.uid === selectedUid ? " selected" : "");
    el.style.left = barsToPx(clip.position) + "px";
    el.style.width = barsToPx(clip.duration) + "px";
    el.dataset.uid = clip.uid;
    if (clip.track === "fx") {
      // Vertical position (and therefore visible top/bottom) is driven
      // entirely by the current stack slot, not CSS -- top/bottom:2px
      // (the single-row default) would fight with a taller lane once
      // clips actually overlap and stack.
      el.style.top = (fxSlotFor(clip) * FX_SUBLANE_PX + 1) + "px";
      el.style.bottom = "";
      el.style.height = (FX_SUBLANE_PX - 2) + "px";
    }

    let bodyHtml;
    if (clip.isSilence) {
      bodyHtml = `<div class="clip-name">Silence</div><div class="clip-sub">${clip.duration} bar${clip.duration > 1 ? "s" : ""}</div>`;
    } else if (clip.track === "fx") {
      bodyHtml = `<div class="clip-name fx-clip-name">${clip.label}</div>`;
    } else {
      const widthPx = barsToPx(clip.duration);
      const barsCount = Math.max(5, Math.round(widthPx / 7));
      let waveHtml = '<div class="clip-wave">';
      const song = clip.songId ? SONGS.find(s => s.id === clip.songId) : null;
      const buf = song && song._matched.buffers ? song._matched.buffers[clip.track] : null;
      if (buf) {
        const endSec = Math.min(buf.duration, clip.sourceStart + clip.duration * BAR_SECONDS);
        computeWaveformBars(buf, clip.sourceStart, endSec, barsCount).forEach(peak => {
          const h = 4 + Math.round(peak * 26);
          waveHtml += `<span style="height:${h}px"></span>`;
        });
      } else {
        // Matched audio hasn't finished loading yet -- decorative placeholder,
        // replaced with the real waveform on the renderClips() that follows
        // preloadMatched() resolving (see dropSectionAt).
        for (let i = 0; i < barsCount; i++) {
          const h = 4 + Math.round(Math.abs(Math.sin(i * 1.7 + clip.uid)) * 26);
          waveHtml += `<span style="height:${h}px"></span>`;
        }
      }
      waveHtml += "</div>";
      bodyHtml = `<div class="clip-name">${clip.label}</div><div class="clip-sub">${clip.songName}</div>${waveHtml}`;
    }

    el.innerHTML = `
      ${bodyHtml}
      <div class="handle left"></div>
      <div class="handle right"></div>
    `;

    el.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("handle")) return;
      startClipMove(e, clip, el);
    });
    el.querySelector(".handle.left").addEventListener("pointerdown", (e) => startClipTrim(e, clip, el, "left"));
    el.querySelector(".handle.right").addEventListener("pointerdown", (e) => startClipTrim(e, clip, el, "right"));

    return el;
  }

  // Reordering and scrolling are both horizontal gestures on a clip, so
  // there's no axis to tell them apart the way the library's drag-out (a
  // vertical lift) can. Instead: a brief hold without moving "commits" to a
  // reorder; moving before that commits treats the gesture as a scroll
  // instead. touch-action:none on .clip (needed so the reorder drag itself
  // isn't fought by the browser) means native scrolling never gets a
  // chance here regardless, so the scroll case replicates it by hand --
  // same approach the library's chip-row drag already uses for the same reason.
  const CLIP_MOVE_HOLD_MS = 160;
  const CLIP_MOVE_THRESHOLD_PX = 6;

  function startClipMove(e, clip, el) {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startCenterBars = clip.position + clip.duration / 2;
    const startScrollLeft = scrollArea.scrollLeft;
    let moved = false;
    let liveDx = 0;
    let liveDxPx = 0, liveDyPx = 0; // FX only: raw pixels, for the horizontal-move-vs-vertical-restack decision
    // Undecided until either the hold delay elapses (-> reorder) or the
    // finger moves past the threshold first (-> scroll).
    let decided = false;
    let isReorder = false;
    selectClip(clip.uid);

    const holdTimer = setTimeout(() => {
      if (!decided) { decided = true; isReorder = true; }
    }, CLIP_MOVE_HOLD_MS);

    function onMove(ev) {
      const dxPx = ev.clientX - startX;
      const dyPx = ev.clientY - startY;
      if (!decided) {
        if (Math.abs(dxPx) > CLIP_MOVE_THRESHOLD_PX) {
          decided = true;
          isReorder = false;
          clearTimeout(holdTimer);
        } else {
          return; // still within the hold window, waiting to see which this is
        }
      }
      if (isReorder) {
        const dx = pxToBars(dxPx);
        if (Math.abs(dx) > 0.05 || (clip.track === "fx" && Math.abs(dyPx) > FX_LAYER_SWAP_THRESHOLD_PX)) moved = true;
        liveDx = dx;
        liveDxPx = dxPx;
        liveDyPx = dyPx;
        // Free visual drag only — the real array order (and therefore every
        // clip's actual position) is untouched until release, so nothing here
        // can produce a gap or overlap mid-gesture.
        el.style.left = barsToPx(clip.position + dx) + "px";
        if (clip.track === "fx") {
          // Lift the clip vertically with the finger too -- without this,
          // dragging up/down to restack looked like it silently did
          // nothing until release, reading as broken rather than as a
          // real gesture. .layer isn't touched until release (swapFxLayer
          // there), so fxSlotFor(clip) stays at its pre-drag value for the
          // whole gesture -- this is just that fixed baseline plus the
          // raw finger offset, not a live re-preview of the eventual swap.
          el.style.top = (fxSlotFor(clip) * FX_SUBLANE_PX + 1 + dyPx) + "px";
          el.style.zIndex = 5; // stay visually on top while passing over whatever it's about to swap with
        }
      } else {
        scrollArea.scrollLeft = startScrollLeft - dxPx;
      }
    }
    function cleanup() {
      clearTimeout(holdTimer);
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      cancelActiveGesture = null;
    }
    function onUp() {
      cleanup();
      // Released before the hold delay and without moving past the
      // threshold either -- a plain, quick tap.
      if (!decided) { openInspector(clip.uid); return; }
      if (!isReorder) return; // was a scroll gesture, nothing left to do
      if (moved) {
        if (clip.track === "fx") {
          // A vertical drag that outweighs the horizontal one restacks
          // instead of repositioning -- swaps priority with whichever FX
          // clip it currently overlaps that's immediately next in that
          // direction (see swapFxLayer). Committed on release only; there's
          // no live vertical preview mid-drag, just the horizontal one.
          const vertical = Math.abs(liveDyPx) > Math.abs(liveDxPx) && Math.abs(liveDyPx) > FX_LAYER_SWAP_THRESHOLD_PX;
          if (vertical) {
            swapFxLayer(clip, liveDyPx < 0 ? -1 : 1);
          } else {
            // Free positioning, not flush-packing -- el.style.left already
            // live-previewed clip.position + liveDx during the drag, so just
            // commit that same left edge (snapped, depth-checked). Silently
            // reverts to the original position if it would stack too deep.
            moveFxClip(clip, clip.position + liveDx);
          }
          renderClips();
          selectClip(clip.uid);
        } else {
          reorderClip(clip, startCenterBars + liveDx);
        }
        commitHistory();
      } else {
        openInspector(clip.uid); // held past the delay but never actually moved -> still a tap
      }
    }
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    // A pinch's second finger can land while this is mid-drag -- hand off
    // cleanly by detaching without committing a reorder, and discard any
    // in-progress visual offset (see onMove's el.style.left) by re-rendering
    // from the real, untouched clip data.
    cancelActiveGesture = () => { cleanup(); renderClips(); };
  }

  // Figures out where a dragged clip's center point falls among its siblings
  // (laid out flush, as if the dragged clip weren't there) and splices it
  // into that slot. layout() then re-derives every position from scratch,
  // so the result is always gapless regardless of where exactly it was dropped.
  function reorderClip(clip, virtualCenterBars) {
    const type = clip.track;
    const arr = clips[type];
    const others = arr.filter(c => c !== clip);

    let pos = 0;
    const laidOut = others.map(c => {
      const item = { clip: c, position: pos, duration: c.duration };
      pos += c.duration;
      return item;
    });

    let targetIdx = laidOut.length; // default: last
    for (let i = 0; i < laidOut.length; i++) {
      const s = laidOut[i];
      if (virtualCenterBars < s.position + s.duration) {
        const midpoint = s.position + s.duration / 2;
        targetIdx = (virtualCenterBars >= midpoint) ? i + 1 : i;
        break;
      }
    }

    arr.splice(arr.indexOf(clip), 1);
    arr.splice(targetIdx, 0, clip);
    layout(type);
    renderClips();
    selectClip(clip.uid);
  }

  // FX's equivalent of reorderClip -- no siblings to slot between, just an
  // absolute left edge, snapped to the nearest bar. No-ops (leaves
  // clip.position untouched) if the target spot would overlap another FX
  // clip, per fxOverlaps' comment.
  function moveFxClip(clip, desiredLeftBars) {
    const snapped = snap(desiredLeftBars, 1);
    if (fxExceedsMaxLayers({ position: snapped, duration: clip.duration }, clip.uid)) return;
    clip.position = snapped;
    // .layer is untouched by a horizontal move -- stacking order only
    // changes via an explicit vertical drag (see startClipMove's
    // swapFxLayer branch) or when a brand-new clip is created.
  }

  function startClipTrim(e, clip, el, side) {
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startDur = clip.duration;
    let finalDx = 0;
    selectClip(clip.uid);

    // Real clips are backed by a fixed-length buffer -- trimming past the
    // section's original bounds is allowed (up to the full stem), but not
    // past the buffer's actual start/end, so figure out how many bars of
    // headroom exist on whichever side is being dragged.
    const song = clip.songId ? SONGS.find(s => s.id === clip.songId) : null;
    const buf = song && song._matched.buffers ? song._matched.buffers[clip.track] : null;
    let maxDurBars = Infinity;
    if (buf) {
      maxDurBars = side === "right"
        ? Math.floor((buf.duration - clip.sourceStart) / BAR_SECONDS)
        : Math.floor(clip.sourceEnd / BAR_SECONDS);
      maxDurBars = Math.max(MIN_DUR_BARS, maxDurBars);
    }
    function previewDuration() {
      const raw = side === "right"
        ? Math.max(MIN_DUR_BARS, roundStep(startDur + finalDx, 1))
        : Math.max(MIN_DUR_BARS, roundStep(startDur - finalDx, 1));
      // FX has no source buffer to bound it, but growing can still stack it
      // past MAX_FX_LAYERS or push its position below bar 0 -- shrinking
      // from the requested size only ever reduces both risks, so walking
      // down from `raw` is guaranteed to land on a valid value at or before
      // startDur (the clip's own pre-gesture state, which must already be
      // valid). Re-checked live every frame rather than precomputed once,
      // since which sizes are valid can itself depend on this clip's
      // current (still-changing) position during a left-handle drag.
      if (clip.track === "fx") {
        for (let d = raw; d > MIN_DUR_BARS; d--) {
          const candidate = side === "right"
            ? { position: clip.position, duration: d }
            : { position: (clip.position + startDur) - d, duration: d };
          if (candidate.position >= 0 && !fxExceedsMaxLayers(candidate, clip.uid)) return d;
        }
        return MIN_DUR_BARS;
      }
      return Math.min(raw, maxDurBars);
    }

    function onMove(ev) {
      finalDx = pxToBars(ev.clientX - startX);
      const newDur = previewDuration();
      el.style.width = barsToPx(newDur) + "px";
      // Vocal/Beats: the clip's start (its left edge) never moves for
      // either handle during the drag -- only its width does, and
      // layout() reconciles position afterward. That's tied to which part
      // of the real source stem gets revealed, not just where the clip
      // sits on the timeline, so it's left as-is here.
      // FX clips have no source buffer semantics, so there's nothing to
      // preserve by waiting -- live-track the left edge too, so whichever
      // handle you're dragging is the one that visibly moves and the other
      // stays anchored throughout, instead of only snapping into place
      // on release.
      if (clip.track === "fx" && side === "left") {
        el.style.left = barsToPx((clip.position + startDur) - newDur) + "px";
      }
    }
    function cleanup() {
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      cancelActiveGesture = null;
    }
    function onUp() {
      cleanup();

      const type = clip.track;
      const newDuration = previewDuration();
      clip.duration = newDuration;
      // Keep whichever edge wasn't dragged anchored in source-buffer time,
      // and derive the other edge from the new duration -- so extending a
      // handle reveals more of the real stem on that side, and shrinking
      // it gives that portion back, without ever touching the fixed edge.
      if (buf) {
        if (side === "right") clip.sourceEnd = clip.sourceStart + clip.duration * BAR_SECONDS;
        else clip.sourceStart = clip.sourceEnd - clip.duration * BAR_SECONDS;
      }
      if (type === "fx") {
        // No layout() reflow for FX -- instead, a left-handle trim moves
        // position itself (grow left = duration up, right edge fixed);
        // a right-handle trim already left position untouched above.
        if (side === "left") clip.position = Math.max(0, (clip.position + startDur) - newDuration);
      } else {
        // Vocal/Beats: this clip's position is untouched, and layout()
        // pushes everything after it out to make room, guaranteeing no
        // overlap and no gap regardless of which handle changed the length.
        layout(type);
      }

      renderClips();
      selectClip(clip.uid);
      commitHistory();
    }
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    // Same pinch handoff as startClipMove: detach without committing a
    // trim, and discard the in-progress visual width change (onMove's
    // el.style.width) by re-rendering from the real, untouched clip data.
    cancelActiveGesture = () => { cleanup(); renderClips(); };
  }

  // ---------- Selection / inspector ----------
  function findClip(uid) {
    return clips.vocal.find(c => c.uid === uid) || clips.beats.find(c => c.uid === uid) || clips.fx.find(c => c.uid === uid);
  }

  function selectClip(uid) {
    selectedUid = uid;
    document.querySelectorAll(".clip").forEach(el => {
      el.classList.toggle("selected", Number(el.dataset.uid) === uid);
    });
  }

  // Opens the inspector panel — only called from a deliberate tap on an
  // already-placed clip, never automatically after a drop/move/trim. Those
  // actions still highlight the clip's border via selectClip(), but popping
  // the inspector open every time would repeatedly cover the library below
  // it (it floats as a fixed overlay) and block the next drag before the
  // user ever gets a chance to start it.
  function openInspector(uid) {
    selectClip(uid);
    const clip = findClip(uid);
    if (!clip) { inspector.classList.remove("show"); return; }
    volSlider.value = Math.round(clip.volume * 100);
    volVal.textContent = Math.round(clip.volume * 100) + "%";
    updateVolSliderFill();
    inspector.classList.toggle("fx-clip", clip.track === "fx");
    if (clip.track === "fx") renderFxCurveEditor(clip);
    inspector.classList.add("show");
    // Only meaningful once the inspector (display:none until .show) is
    // actually laid out -- computing it any earlier, inside
    // renderFxCurveEditor above, would read a zero-size box.
    if (clip.track === "fx") updateFxCurveUnsquish();
  }

  // Paints the filled (played) portion of the volume track up to the thumb,
  // matching the real app's solid-fill slider look instead of the browser's
  // flat default track.
  function updateVolSliderFill() {
    const pct = Number(volSlider.value);
    volSlider.style.background = `linear-gradient(to right, var(--pink) ${pct}%, var(--border) ${pct}%)`;
  }

  // ---------- FX curve editor ----------
  // LFO-drawing-tool style: any number of draggable nodes (Xfer LFO Tool
  // was the explicit reference), connected by straight lines by default
  // (fxCurveValueAtT), each independently bowable by dragging its segment
  // handle -- a small marker sitting on the curve at that segment's
  // midpoint -- up or down. The two end nodes are fixed at t=0/t=1, v=0 --
  // not draggable, not deletable, no pointer handler at all -- everything
  // else is freely addable, draggable, and deletable.
  // curveEditorNodes/curveEditorSegCurves/curveEditorClip/
  // selectedCurveNodeIndex track the editor's live, uncommitted state;
  // nothing writes to clip.curve until an actual edit happens (see
  // commitCurveEdit).
  const FX_CURVE_W = 200, FX_CURVE_H = 120; // the plotted curve area, in SVG user units
  // fxCurveSvg's actual viewBox is padded out by this much on every side
  // (see index.html) so that a node/segment hit-circle centered right at
  // the plot's own edge -- e.g. the default curve's locked v=0 endpoints,
  // or a dragged node pinned to v=1 -- doesn't get silently clipped by the
  // SVG's own overflow, which would shrink exactly the touch target this
  // padding exists to keep full-size.
  const FX_CURVE_PAD = 18;
  const FX_VIEWBOX_MINX = -FX_CURVE_PAD, FX_VIEWBOX_MINY = -FX_CURVE_PAD;
  const FX_VIEWBOX_W = FX_CURVE_W + FX_CURVE_PAD * 2, FX_VIEWBOX_H = FX_CURVE_H + FX_CURVE_PAD * 2;
  // The minimum time-gap a node is ever allowed from its neighbors, as a
  // fraction of the clip -- purely a numerical safety floor (no zero- or
  // negative-width segment) during a drag, not a UX distance in itself,
  // so it stays tiny: a fraction-space floor this small is already an
  // absolute time far below anything perceptible, at any clip length.
  // Kept below FX_DEFAULT_DROP_SEC's own smallest resulting fraction (on
  // the longest, 16-bar clip) so this floor never overrides that target.
  const FX_CURVE_MIN_NODE_GAP = 0.0004;
  // The default curve's peak node sits this many seconds before the end
  // node, converted to a fraction of *this* clip's duration -- not a
  // fixed fraction like FX_CURVE_MIN_NODE_GAP above, because a fixed
  // fraction's absolute duration scales with the clip (a first attempt at
  // this used exactly that, pinning the node to the closest position the
  // drag clamp allowed -- fine at 4s but a noticeably slow ~320ms drop at
  // 32s). A fixed absolute duration is what the old hardcoded reset ramp
  // this curve model replaced actually had (~15ms); 20ms carries that
  // "reads as a snap, not a ramp" intent forward almost exactly, with
  // just enough headroom over the original figure to stay a real,
  // schedulable ramp rather than an instant step.
  const FX_DEFAULT_DROP_SEC = 0.02;
  const SVG_NS = "http://www.w3.org/2000/svg";
  let curveEditorClip = null;
  let curveEditorNodes = null;
  let curveEditorSegCurves = null;
  let selectedCurveNodeIndex = null;

  function curveToSvg(t, v) { return { x: t * FX_CURVE_W, y: FX_CURVE_H - v * FX_CURVE_H }; } // y flips: curve-space grows up, SVG grows down
  function svgToCurve(x, y) {
    return {
      t: Math.min(1, Math.max(0, x / FX_CURVE_W)),
      v: Math.min(1, Math.max(0, 1 - y / FX_CURVE_H)),
    };
  }
  function svgPointFromEvent(ev) {
    const rect = fxCurveSvg.getBoundingClientRect();
    return {
      x: FX_VIEWBOX_MINX + (ev.clientX - rect.left) / rect.width * FX_VIEWBOX_W,
      y: FX_VIEWBOX_MINY + (ev.clientY - rect.top) / rect.height * FX_VIEWBOX_H,
    };
  }

  // preserveAspectRatio="none" stretches x and y independently to fill the
  // box, which is exactly what lets the curve/grid span the full width at
  // a fixed height -- but it also stretches every circular node/handle
  // into an ellipse, more so the wider the box gets (height is fixed, so
  // only the x-scale grows). Rather than give up the non-uniform stretch
  // for the whole plot, only the circular markers get a corrective
  // horizontal scale (`--fx-curve-unsquish` in the stylesheet, via
  // `transform-box: fill-box` so it scales each one around its own
  // center) that cancels the box's own aspect distortion back out, sized
  // to whichever axis is more constrained (in practice always the fixed
  // height) -- so a dot reads as a true circle at any viewport width, and
  // stays the same pixel size rather than growing with the box.
  function updateFxCurveUnsquish() {
    const rect = fxCurveSvg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scaleX = rect.width / FX_VIEWBOX_W;
    const scaleY = rect.height / FX_VIEWBOX_H;
    fxCurveSvg.style.setProperty("--fx-curve-unsquish", scaleY / scaleX);
  }
  window.addEventListener("resize", updateFxCurveUnsquish);

  function fxDefaultSegCurves(nodeCount) {
    return new Array(Math.max(0, nodeCount - 1)).fill(null);
  }

  // Inserting a node splits one segment (at splitSegIndex, the old segment
  // between the two nodes the new one lands between) into two -- both new
  // halves reset to straight, since a single bow value can't represent two
  // segments at once, but every *other* segment's bow is unrelated to this
  // split and carries over unchanged (just shifted to make room).
  function fxSegCurvesAfterNodeAdd(segCurves, splitSegIndex) {
    const result = [];
    for (let i = 0; i < segCurves.length; i++) {
      if (i === splitSegIndex) { result.push(null, null); continue; }
      result.push(segCurves[i]);
    }
    return result;
  }

  // Deleting a node merges the two segments touching it -- (deletedIndex-1)
  // and deletedIndex -- into one new segment, which resets to straight (a
  // straight-line merge is unambiguous where two independently-bowed
  // segments joining wouldn't be); every other segment's bow is untouched
  // by this deletion and carries over unchanged.
  function fxSegCurvesAfterNodeDelete(segCurves, deletedIndex) {
    const result = [];
    for (let i = 0; i < segCurves.length; i++) {
      if (i === deletedIndex) continue; // merges into the slot below
      result.push(i === deletedIndex - 1 ? null : segCurves[i]);
    }
    return result;
  }

  // Quarter grid lines (faint, full-span) plus matching tick marks (solid,
  // just outside the plot in the padding margin) on both axes -- reading a
  // node's position as "about a quarter/half/three-quarters through" is
  // the whole point, same as Xfer LFO Tool's own grid. Static regardless
  // of the curve's shape, so this only needs to run once per inspector open.
  function drawFxCurveGrid() {
    fxCurveGridGroup.innerHTML = "";
    const fracs = [0.25, 0.5, 0.75];
    const tickLen = 5;
    fracs.forEach(t => {
      const x = t * FX_CURVE_W;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", x); line.setAttribute("x2", x);
      line.setAttribute("y1", 0); line.setAttribute("y2", FX_CURVE_H);
      line.setAttribute("class", "fx-curve-grid-line");
      fxCurveGridGroup.appendChild(line);

      const tick = document.createElementNS(SVG_NS, "line");
      tick.setAttribute("x1", x); tick.setAttribute("x2", x);
      tick.setAttribute("y1", FX_CURVE_H); tick.setAttribute("y2", FX_CURVE_H + tickLen);
      tick.setAttribute("class", "fx-curve-tick");
      fxCurveGridGroup.appendChild(tick);
    });
    fracs.forEach(v => {
      const y = FX_CURVE_H - v * FX_CURVE_H;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("y1", y); line.setAttribute("y2", y);
      line.setAttribute("x1", 0); line.setAttribute("x2", FX_CURVE_W);
      line.setAttribute("class", "fx-curve-grid-line");
      fxCurveGridGroup.appendChild(line);

      const tick = document.createElementNS(SVG_NS, "line");
      tick.setAttribute("y1", y); tick.setAttribute("y2", y);
      tick.setAttribute("x1", 0); tick.setAttribute("x2", -tickLen);
      tick.setAttribute("class", "fx-curve-tick");
      fxCurveGridGroup.appendChild(tick);
    });
  }

  function fxCurvePathD(nodes, segCurves) {
    const steps = 60;
    let d = "";
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const v = Math.min(1, Math.max(0, fxCurveValueAtT(nodes, t, segCurves)));
      const pt = curveToSvg(t, v);
      d += (i === 0 ? "M " : "L ") + pt.x + " " + pt.y + " ";
    }
    return d;
  }

  function drawFxCurve() {
    const nodes = curveEditorNodes;
    const segCurves = curveEditorSegCurves;
    fxCurvePath.setAttribute("d", fxCurvePathD(nodes, segCurves));

    // Segment bow handles first, so the point-nodes drawn after them sit on
    // top and always win the hit-test where the two might overlap.
    fxCurveSegHandlesGroup.innerHTML = "";
    for (let i = 0; i < nodes.length - 1; i++) {
      const midT = (nodes[i].t + nodes[i + 1].t) / 2;
      const midV = Math.min(1, Math.max(0, fxCurveValueAtT(nodes, midT, segCurves)));
      const pt = curveToSvg(midT, midV);
      const isBowed = typeof segCurves[i] === "number";
      // A larger invisible circle carries the pointer handler so the
      // segment is easy to grab on a touch screen; the small visible dot
      // underneath it is just a marker and never itself receives events.
      const hit = document.createElementNS(SVG_NS, "circle");
      hit.setAttribute("cx", pt.x);
      hit.setAttribute("cy", pt.y);
      hit.setAttribute("r", 14);
      hit.setAttribute("class", "fx-curve-seg-hit");
      hit.addEventListener("pointerdown", (e) => startCurveSegDrag(e, i));
      fxCurveSegHandlesGroup.appendChild(hit);
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", pt.x);
      dot.setAttribute("cy", pt.y);
      dot.setAttribute("r", 3);
      dot.setAttribute("class", "fx-curve-seg-handle" + (isBowed ? " active" : ""));
      fxCurveSegHandlesGroup.appendChild(dot);
    }

    fxCurveNodesGroup.innerHTML = "";
    nodes.forEach((node, i) => {
      const isEndpoint = i === 0 || i === nodes.length - 1;
      const isSelected = i === selectedCurveNodeIndex;
      const pt = curveToSvg(node.t, node.v);
      if (!isEndpoint) {
        // Same larger-invisible-hit-target pattern as the segment handles
        // above -- the visible dot is only 6-8 viewBox units (~10-15
        // screen px after the SVG's non-uniform stretch), too small to
        // reliably hit on a touch screen.
        const hit = document.createElementNS(SVG_NS, "circle");
        hit.setAttribute("cx", pt.x);
        hit.setAttribute("cy", pt.y);
        hit.setAttribute("r", 16);
        hit.setAttribute("class", "fx-curve-node-hit");
        hit.addEventListener("pointerdown", (e) => startCurveNodeDrag(e, i));
        fxCurveNodesGroup.appendChild(hit);
      }
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", pt.x);
      circle.setAttribute("cy", pt.y);
      circle.setAttribute("r", isEndpoint ? 4 : (isSelected ? 8 : 6));
      circle.setAttribute("class", "fx-curve-node" + (isEndpoint ? " anchor" : "") + (isSelected ? " selected" : ""));
      fxCurveNodesGroup.appendChild(circle);
    });
    fxCurveDeleteNode.disabled = selectedCurveNodeIndex === null;
  }

  // Opening the inspector on a clip with no custom curve just previews the
  // default shape -- nothing is written to clip.curve until an actual
  // edit happens, so merely looking at a clip never silently converts it.
  function renderFxCurveEditor(clip) {
    curveEditorClip = clip;
    curveEditorNodes = (clip.curve && clip.curve.nodes) || fxDefaultCurveNodes(barsToSeconds(clip.duration));
    curveEditorSegCurves = (clip.curve && clip.curve.curves) || fxDefaultSegCurves(curveEditorNodes.length);
    selectedCurveNodeIndex = null;
    drawFxCurveGrid();
    drawFxCurve();
  }

  function commitCurveEdit() {
    if (!curveEditorClip) return;
    curveEditorClip.curve = { nodes: curveEditorNodes, curves: curveEditorSegCurves };
    commitHistory();
  }

  function startCurveNodeDrag(e, index) {
    e.preventDefault();
    e.stopPropagation();
    const pointerId = e.pointerId;
    const startX = e.clientX, startY = e.clientY;
    let moved = false;

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 3) moved = true;
      if (!moved) return;
      const svgPt = svgPointFromEvent(ev);
      const curvePt = svgToCurve(svgPt.x, svgPt.y);
      // Keep nodes ordered in time -- clamped between its immediate
      // neighbors so dragging one can't cross over another, which would
      // make "the curve" ambiguous at that time.
      const prevT = curveEditorNodes[index - 1].t;
      const nextT = curveEditorNodes[index + 1].t;
      curveEditorNodes[index].t = Math.min(nextT - FX_CURVE_MIN_NODE_GAP, Math.max(prevT + FX_CURVE_MIN_NODE_GAP, curvePt.t));
      curveEditorNodes[index].v = curvePt.v;
      drawFxCurve();
    }
    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (moved) {
        commitCurveEdit();
      } else {
        // A tap, not a drag -- select/deselect this node instead of moving it.
        selectedCurveNodeIndex = selectedCurveNodeIndex === index ? null : index;
        drawFxCurve();
      }
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  // Bowing a segment: the handle sits on the curve at the segment's own
  // midpoint (t fixed there), and dragging it vertically moves that exact
  // point to follow the pointer -- horizontal movement is ignored, since
  // this is "grab the line and pull up/down," not a freely-placed handle.
  // Internally this is one quadratic-Bezier control value per segment
  // (fxCurveValueAtT); solving for the control value that puts the curve's
  // own rendered midpoint (V(0.5) = 0.5*controlV + 0.25*(p0.v+p1.v)) under
  // the pointer keeps what the user sees matching what they're dragging.
  function startCurveSegDrag(e, index) {
    e.preventDefault();
    e.stopPropagation();
    const pointerId = e.pointerId;
    const startX = e.clientX, startY = e.clientY;
    let moved = false;
    const p0 = curveEditorNodes[index], p1 = curveEditorNodes[index + 1];

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 3) moved = true;
      if (!moved) return;
      const svgPt = svgPointFromEvent(ev);
      const dragV = svgToCurve(svgPt.x, svgPt.y).v;
      const controlV = 2 * dragV - 0.5 * (p0.v + p1.v);
      curveEditorSegCurves[index] = Math.min(1, Math.max(0, controlV));
      drawFxCurve();
    }
    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (moved) commitCurveEdit();
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  fxCurveAddNode.addEventListener("click", () => {
    if (!curveEditorClip) return;
    const nodes = curveEditorNodes;
    // Drop the new node into the largest existing gap -- the clearest
    // spot to grab without immediately colliding with a neighbor -- right
    // on the curve's own current value there, so adding one never itself
    // visibly changes the shape until it's dragged.
    let bestIdx = 0, bestGap = -1;
    for (let i = 0; i < nodes.length - 1; i++) {
      const gap = nodes[i + 1].t - nodes[i].t;
      if (gap > bestGap) { bestGap = gap; bestIdx = i; }
    }
    const midT = (nodes[bestIdx].t + nodes[bestIdx + 1].t) / 2;
    const midV = Math.min(1, Math.max(0, fxCurveValueAtT(nodes, midT, curveEditorSegCurves)));
    // Splitting a segment resets its own bow (a single value can't
    // represent two segments), but every other segment's bow is
    // unaffected and must not be touched.
    curveEditorSegCurves = fxSegCurvesAfterNodeAdd(curveEditorSegCurves, bestIdx);
    nodes.splice(bestIdx + 1, 0, { t: midT, v: midV });
    selectedCurveNodeIndex = bestIdx + 1;
    drawFxCurve();
    commitCurveEdit();
  });

  fxCurveDeleteNode.addEventListener("click", () => {
    if (!curveEditorClip || selectedCurveNodeIndex === null) return;
    // Merging the two segments this node touches into one resets *that*
    // segment to straight, but every other segment's bow carries over.
    curveEditorSegCurves = fxSegCurvesAfterNodeDelete(curveEditorSegCurves, selectedCurveNodeIndex);
    curveEditorNodes.splice(selectedCurveNodeIndex, 1);
    selectedCurveNodeIndex = null;
    drawFxCurve();
    commitCurveEdit();
  });

  fxCurveReset.addEventListener("click", () => {
    if (!curveEditorClip) return;
    delete curveEditorClip.curve;
    curveEditorNodes = fxDefaultCurveNodes(barsToSeconds(curveEditorClip.duration));
    curveEditorSegCurves = fxDefaultSegCurves(curveEditorNodes.length);
    selectedCurveNodeIndex = null;
    drawFxCurve();
    commitHistory();
  });

  closeInsp.addEventListener("click", () => {
    selectedUid = null;
    document.querySelectorAll(".clip").forEach(el => el.classList.remove("selected"));
    inspector.classList.remove("show");
  });

  duplicateClipBtn.addEventListener("click", () => {
    if (selectedUid == null) return;
    const original = findClip(selectedUid);
    if (!original) return;
    const type = original.track;
    const arr = clips[type];
    const idx = arr.indexOf(original);
    const clone = { ...original, uid: uidCounter++ };
    if (type === "fx") {
      // No flush order to insert into -- place it right after the
      // original, nudging right bar-by-bar until the stack there has room.
      // Duplicating is "creating a new clip" too, so it lands on top like
      // any other new FX clip.
      let pos = original.position + original.duration;
      while (fxExceedsMaxLayers({ position: pos, duration: clone.duration }, clone.uid) && pos < TOTAL_BARS) pos++;
      clone.position = pos;
      clone.layer = allocateTopFxLayer();
      arr.push(clone);
    } else {
      arr.splice(idx + 1, 0, clone);
      layout(type);
    }
    renderClips();
    openInspector(clone.uid);
    scrollClipIntoView(clone);
    commitHistory();
  });

  deleteClipBtn.addEventListener("click", () => {
    if (selectedUid == null) return;
    const original = findClip(selectedUid);
    const type = original ? original.track : null;
    ["vocal", "beats", "fx"].forEach(t => { clips[t] = clips[t].filter(c => c.uid !== selectedUid); });
    // FX clips are freely positioned -- deleting one shouldn't drag its
    // remaining siblings' positions along with it, so skip the reflow there.
    if (type && type !== "fx") layout(type); // close the gap left behind, keep the track flush
    selectedUid = null;
    inspector.classList.remove("show");
    renderClips();
    commitHistory();
  });

  volSlider.addEventListener("input", () => {
    const clip = findClip(selectedUid);
    if (!clip) return;
    clip.volume = Number(volSlider.value) / 100;
    volVal.textContent = volSlider.value + "%";
    updateVolSliderFill();
  });
  volSlider.addEventListener("change", commitHistory);

  // ---------- Undo / redo ----------
  function snapshot() { return JSON.parse(JSON.stringify(clips)); }
  // Every mutating action (drop, move, trim, duplicate, delete, volume
  // change) commits here, and undo/redo both land here too -- pausing
  // uniformly at this one point means playback never keeps running against
  // a snapshot of the timeline that no longer matches what's on screen.
  // Live-updating in-progress playback to match instead was the other
  // option; pausing is far simpler and avoids that whole class of bug.
  function commitHistory() {
    pause();
    history = history.slice(0, historyIndex + 1);
    history.push(snapshot());
    historyIndex++;
    updateHistoryButtons();
  }
  function undo() {
    if (historyIndex <= 0) return;
    pause();
    historyIndex--;
    clips = JSON.parse(JSON.stringify(history[historyIndex]));
    renderClips();
    updateHistoryButtons();
  }
  function redo() {
    if (historyIndex >= history.length - 1) return;
    pause();
    historyIndex++;
    clips = JSON.parse(JSON.stringify(history[historyIndex]));
    renderClips();
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    undoBtn.classList.toggle("disabled", historyIndex <= 0);
    redoBtn.classList.toggle("disabled", historyIndex >= history.length - 1);
  }
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);

  // Reset is itself a tracked history entry rather than a blocking confirm
  // dialog — if it was a mistake, Undo brings the arrangement right back.
  function resetArrangement() {
    stopPreview();
    pause();
    selectedUid = null;
    inspector.classList.remove("show");
    playheadBar = 0;

    clips.vocal = [];
    clips.beats = [];
    clips.fx = [];

    renderClips();
    updatePlayheadEl();
    commitHistory();
  }
  resetBtn.addEventListener("click", resetArrangement);

  // ---------- Audio synthesis ----------
  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  // iOS treats a raw AudioContext's default output as "ambient" audio, which
  // the ring/silent switch is allowed to mute outright -- confirmed on a
  // real device: context running, a node genuinely scheduled, decoded
  // buffers carrying real (non-silent) samples, yet total silence. Real
  // <audio>/<video> playback is categorized differently and isn't subject
  // to that. First attempt routed the whole graph through a
  // MediaStreamAudioDestinationNode into an <audio> element -- got real
  // sound, but consistently glitchy/stuttering, a known WebKit instability
  // with that combination. Switched to a lower-risk pattern instead: leave
  // the main graph on ctx.destination entirely untouched, and separately
  // loop a tiny silent WAV through a real <audio src> element purely to
  // claim the page's audio session as "playback" -- iOS applies that
  // category page-wide, not per-source, so the main graph benefits without
  // ever touching its signal path.
  function ensureSilentLoop(ctx) {
    // Independent of any AudioContext once created (it's just a plain
    // element looping a WAV blob) -- doesn't need recreating alongside a
    // context swap the way the main graph does.
    if (masterOutCache) { masterOutCache.el.play().catch(() => {}); return; }
    const el = document.createElement("audio");
    const silentBuf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.5)), ctx.sampleRate);
    el.src = URL.createObjectURL(audioBufferToWav(silentBuf));
    el.loop = true;
    el.playsInline = true;
    el.style.display = "none";
    document.body.appendChild(el);
    el.play().catch(() => {});
    masterOutCache = { el };
  }

  // iOS/WKWebView unlock: must create + start a real buffer source inside a user gesture
  // before any subsequently-scheduled audio will be audible. Attempted silently in the
  // background (on first touch, and again on Play) — no visible UI for this in the real
  // product, so none here either. Audio itself isn't being worked on yet; this just gives
  // it its best shot without surfacing anything to the user.
  function unlockAudio() {
    const ctx = getCtx();
    try {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      ensureSilentLoop(ctx);
    } catch (err) {
      return;
    }
    if (ctx.state === "suspended") {
      ctx.resume().then(() => { audioUnlocked = getCtx().state === "running"; }).catch(() => {});
    } else {
      audioUnlocked = ctx.state === "running";
    }
  }

  // Every place that's about to schedule audio should call this and await it
  // first, rather than firing resume() and hoping. iOS in particular can
  // leave the context "suspended" (or, after certain interruptions, "closed"
  // outright) even mid-gesture -- scheduling a BufferSourceNode.start() on a
  // suspended context doesn't error, it just produces no sound, which is
  // exactly the "UI reacts, nothing audible" failure mode. Also recreates a
  // fully closed context rather than trying to resume something that can't be.
  async function ensureAudioReady() {
    unlockAudio();
    let ctx = getCtx();
    if (ctx.state === "closed") {
      audioCtx = null;
      ctx = getCtx();
    }
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch (err) {}
    }
    return ctx;
  }

  // A backgrounded tab suspends the AudioContext on iOS, and it stays
  // suspended on return until a fresh user gesture resumes it -- so if
  // isPlaying was left true from before backgrounding, the internal state
  // no longer matches reality (nothing is actually playing) and the next
  // tap on Play would just call pause(), looking unresponsive. Resync to a
  // clean paused state on return instead, so the next tap reliably goes
  // through the normal, already-robust play() path.
  //
  // That alone isn't enough, though: iOS can leave a backgrounded context
  // as a "zombie" -- resume() resolves and .state reads "running", but its
  // clock/audio graph never actually comes back (currentTime stops
  // advancing, nothing plays, silently). Trying to resume a context that
  // might be zombified isn't reliable, so don't try -- close it outright
  // and let the next getCtx() call build a fresh one from scratch, unlocked
  // the normal way within that next real gesture.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (isPlaying) pause();
    if (audioCtx) {
      const stale = audioCtx;
      audioCtx = null;
      audioUnlocked = false;
      stale.close().catch(() => {});
    }
  });

  document.addEventListener("pointerdown", () => { if (!audioUnlocked) unlockAudio(); }, { once: true, passive: true });

  let noiseBufferCache = null;
  function noiseBuffer(ctx) {
    if (noiseBufferCache && noiseBufferCache.ctx === ctx) return noiseBufferCache.buf;
    const len = Math.floor(ctx.sampleRate * 0.06);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    noiseBufferCache = { ctx, buf };
    return buf;
  }

  // Synthetic reverb impulse response (no IR audio asset to load): stereo
  // white noise shaped with an exponential decay envelope, same idea as
  // noiseBuffer() above but longer and decaying rather than a short
  // percussive burst. Good enough for a "wash," not aiming for a
  // convincing hall/plate emulation.
  let reverbImpulseCache = null;
  function reverbImpulseBuffer(ctx) {
    if (reverbImpulseCache && reverbImpulseCache.ctx === ctx) return reverbImpulseCache.buf;
    const durationSec = 2.5;
    const decay = 3;
    const len = Math.floor(ctx.sampleRate * durationSec);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    reverbImpulseCache = { ctx, buf };
    return buf;
  }

  // ---------- FX audio engine ----------
  // Each FX clip gets its own dedicated audio "unit" (built fresh every
  // play()/export call -- see buildFxChain), chained in series ordered by
  // .layer: master mix -> lowest-layer clip's unit -> ... -> highest-layer's
  // unit -> destination. A unit is only ever non-neutral during its own
  // clip's window, so simply keeping every FX clip's unit permanently in
  // the chain for the whole run is enough to get correct layering for free
  // -- two overlapping clips both apply during their shared window, with no
  // dynamic connect/disconnect scheduling needed. Fresh units every run
  // also means there's nothing to reset between plays -- except any live
  // oscillators (a phaser's LFO): those keep running until explicitly
  // stopped, so the previous run's units are torn down before building a
  // new one (see liveFxChainNodes) rather than just left to accumulate.
  //
  // A unit is `{clip, input, output, automate(at, offsetIntoClipSec)}`.
  // For a simple filter sweep, input and output are the same node (one
  // BiquadFilterNode doubles as both). A phaser needs several internal
  // nodes (an allpass chain, a shared LFO, a dry/wet crossfade), so it
  // exposes its own external input/output gain nodes instead.
  // How many extra ramp checkpoints a *bowed* segment gets beyond its own
  // two endpoints (see fxCurveScheduleBreakpoints below) -- a straight
  // segment needs none, since a single Web Audio ramp between its two
  // endpoint values is already mathematically exact for it.
  const FX_BOW_SUBSAMPLES = 12;

  // ---------- FX custom curves ----------
  // A clip's whole-duration shape (0..1 time in, 0..1 value out) is either
  // the default 3-node curve below, or -- once a user drags/adds/deletes a
  // node in the curve editor -- whatever nodes they've shaped it into.
  // clip.curve, when present, is {nodes: [{t,v}, ...], curves: [n|null, ...]}
  // (curves.length === nodes.length - 1, one entry per segment), sorted by
  // t. nodes[0] is always {t:0, v:0} and the last is always {t:1, v:0} --
  // LOCKED, not draggable or deletable in the editor. That's the whole
  // "always resets cleanly" guardrail: with both ends pinned to neutral,
  // there's no longer a separate hardcoded reset-ramp mechanism bolted on
  // afterward (the curve model used to have one; folding the guarantee
  // into the curve itself let it be removed) -- the user fully controls
  // how gradually or sharply the effect gets back to neutral, just not
  // whether it does.
  function fxDefaultCurveNodes(totalDurSec) {
    // Rises across essentially the entire clip to a peak node sitting
    // FX_DEFAULT_DROP_SEC before the end node -- a fixed absolute
    // duration, not a fixed fraction, so the drop reads equally snappy on
    // a 4s clip and a 32s one. Falls back to the fraction-space safety
    // floor for a degenerate (zero/negative) duration.
    const dropFrac = totalDurSec > 0 ? Math.min(0.5, FX_DEFAULT_DROP_SEC / totalDurSec) : FX_CURVE_MIN_NODE_GAP;
    const peakT = 1 - Math.max(FX_CURVE_MIN_NODE_GAP, dropFrac);
    return [{ t: 0, v: 0 }, { t: peakT, v: 1 }, { t: 1, v: 0 }];
  }

  // Each segment is a quadratic Bezier whose control point's time is
  // pinned to the segment's own midpoint -- which has a nice property:
  // it makes the curve's time axis exactly linear in u (the standard
  // Bezier parameter), so t can be used directly as u with no root-solving
  // needed to invert it. With no explicit segCurves entry, the control
  // value defaults to the straight-line midpoint ((p0.v+p1.v)/2), which
  // makes the Bezier degenerate to a plain straight line -- LFO Tool's own
  // default for a segment with no tension applied. A stored segCurves[i]
  // bows it: the value is solved (in startCurveSegDrag) so that what the
  // user actually sees and drags -- the curve's own rendered midpoint --
  // tracks the pointer, not the abstract Bezier control point itself.
  function fxCurveValueAtT(nodes, t, segCurves) {
    if (t <= nodes[0].t) return nodes[0].v;
    if (t >= nodes[nodes.length - 1].t) return nodes[nodes.length - 1].v;
    for (let i = 0; i < nodes.length - 1; i++) {
      const p0 = nodes[i], p1 = nodes[i + 1];
      if (t <= p1.t) {
        const dt = p1.t - p0.t;
        const u = dt > 0 ? (t - p0.t) / dt : 0;
        const c = (segCurves && typeof segCurves[i] === "number") ? segCurves[i] : (p0.v + p1.v) / 2;
        const inv = 1 - u;
        return inv * inv * p0.v + 2 * inv * u * c + u * u * p1.v;
      }
    }
    return nodes[nodes.length - 1].v;
  }
  // The single point where a custom curve (if any) actually takes over
  // from the default -- everywhere else in the FX engine goes through this
  // (scheduleFxSweep/schedulePhaserSweep, both via
  // fxCurveScheduleBreakpoints, plus each one's own startFrac lookup).
  // Clamped defensively, though a Bezier control value itself clamped to
  // 0..1 keeps the curve within the same range by the convex-hull property.
  function fxCurveFracAt(clip, linFrac) {
    const nodes = (clip.curve && clip.curve.nodes) || fxDefaultCurveNodes(barsToSeconds(clip.duration));
    const segCurves = clip.curve && clip.curve.curves;
    return Math.min(1, Math.max(0, fxCurveValueAtT(nodes, linFrac, segCurves)));
  }

  // The ramp checkpoints scheduling needs to reproduce the curve, as
  // {tSec, frac} pairs from just after offsetIntoClipSec through the
  // clip's end -- built from the curve's own node structure rather than
  // sampling at a fixed count across the whole clip. That fixed-count
  // approach (48 evenly-spaced samples, regardless of clip length) is
  // what the default curve's node-pressed-near-the-end shape exposed as
  // wrong: a 32s clip's samples land ~0.7s apart, coarser than the
  // ~100ms final segment they were supposed to resolve, so the schedule
  // never actually reached the curve's peak or its real drop duration.
  // Sampling per node-segment instead fixes that at the source: a straight
  // (unbowed) segment gets exactly one checkpoint, at its own end node --
  // and that's not an approximation to trim down, it's exact. Within a
  // straight segment, frac is affine in time, so Hz (fromHz*(toHz/fromHz)
  // ^frac, exponential-of-affine) is a pure exponential function of time,
  // and wet (fromWet+(toWet-fromWet)*frac) is a pure linear function of
  // time -- exactly what exponentialRampToValueAtTime/
  // linearRampToValueAtTime already produce between two points on their
  // own. Only a bowed segment (a quadratic Bezier in fraction-space, not
  // affine) actually needs intermediate samples, so only those get
  // FX_BOW_SUBSAMPLES of them, however short or long that one segment is.
  function fxCurveScheduleBreakpoints(clip, totalDurSec, offsetIntoClipSec) {
    const nodes = (clip.curve && clip.curve.nodes) || fxDefaultCurveNodes(totalDurSec);
    const segCurves = clip.curve && clip.curve.curves;
    const startFrac = totalDurSec > 0 ? offsetIntoClipSec / totalDurSec : 1;
    const points = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const p0 = nodes[i], p1 = nodes[i + 1];
      if (p1.t <= startFrac) continue; // this whole segment is already in the past
      const steps = (segCurves && typeof segCurves[i] === "number") ? FX_BOW_SUBSAMPLES : 1;
      for (let s = 1; s <= steps; s++) {
        const t = p0.t + (p1.t - p0.t) * (s / steps);
        if (t <= startFrac) continue; // partway through this segment already
        points.push({ tSec: t * totalDurSec, frac: fxCurveValueAtT(nodes, t, segCurves) });
      }
    }
    return points;
  }

  // fromHz -> toHz over the curve's shape across the whole clip. Locking
  // both curve endpoints to value 0 (see fxDefaultCurveNodes) is what
  // guarantees this always lands back on fromHz by the clip's end, so
  // there's no separate reset-ramp step here anymore. offsetIntoClipSec
  // lets a clip that starts partway through (a seek landing inside it)
  // resume from the curve's correct value instead of restarting at fromHz.
  function scheduleFxSweep(node, cfg, clip, at, offsetIntoClipSec) {
    const totalDurSec = barsToSeconds(clip.duration);
    const startFrac = totalDurSec > 0 ? offsetIntoClipSec / totalDurSec : 1;
    const hzAt = (frac) => cfg.fromHz * Math.pow(cfg.toHz / cfg.fromHz, frac);
    const p = node.frequency;

    p.setValueAtTime(hzAt(fxCurveFracAt(clip, startFrac)), at);
    fxCurveScheduleBreakpoints(clip, totalDurSec, offsetIntoClipSec).forEach(({ tSec, frac }) => {
      p.exponentialRampToValueAtTime(hzAt(frac), at + (tSec - offsetIntoClipSec));
    });
  }

  // fromWet -> toWet crossfade (dryGain always kept as the complement,
  // 1 - wet -- a simple linear crossfade, not equal-power; fine for a v1
  // proof of concept) across the whole clip, same idea as the filter sweep
  // above but linear, since 0 is a valid, needed endpoint here.
  function schedulePhaserSweep(dryGain, wetGain, cfg, clip, at, offsetIntoClipSec) {
    const totalDurSec = barsToSeconds(clip.duration);
    const startFrac = totalDurSec > 0 ? offsetIntoClipSec / totalDurSec : 1;
    const wetAt = (frac) => cfg.fromWet + (cfg.toWet - cfg.fromWet) * frac;

    const startWet = wetAt(fxCurveFracAt(clip, startFrac));
    wetGain.gain.setValueAtTime(startWet, at);
    dryGain.gain.setValueAtTime(1 - startWet, at);
    fxCurveScheduleBreakpoints(clip, totalDurSec, offsetIntoClipSec).forEach(({ tSec, frac }) => {
      const w = wetAt(frac);
      const segAt = at + (tSec - offsetIntoClipSec);
      wetGain.gain.linearRampToValueAtTime(w, segAt);
      dryGain.gain.linearRampToValueAtTime(1 - w, segAt);
    });
  }

  // Builds one FX clip's audio unit. `track`, when provided, records every
  // node created so a later teardown pass can disconnect (and stop, for
  // anything with a lifecycle -- an LFO oscillator) everything this unit
  // made; used for the live context only (see buildFxChain).
  function buildFxUnit(ctx, clip, track) {
    const cfg = fxEffectFor(clip.effectId);
    if (cfg.kind === "phaser") {
      // input -> dryGain -> output
      //       -> allpass x stages (shared LFO modulates all of them in
      //          phase, which is what creates the moving notches) -> wetGain -> output
      const input = track(ctx.createGain());
      const output = track(ctx.createGain());
      const dryGain = track(ctx.createGain());
      const wetGain = track(ctx.createGain());
      dryGain.gain.value = 1;
      wetGain.gain.value = 0;
      input.connect(dryGain).connect(output);

      let node = input;
      const allpasses = [];
      for (let i = 0; i < cfg.stages; i++) {
        const ap = track(ctx.createBiquadFilter());
        ap.type = "allpass";
        ap.frequency.value = cfg.centerHz;
        node.connect(ap);
        node = ap;
        allpasses.push(ap);
      }
      node.connect(wetGain).connect(output);

      const lfo = track(ctx.createOscillator());
      lfo.type = "sine";
      lfo.frequency.value = cfg.lfoRateHz;
      const lfoDepth = track(ctx.createGain());
      lfoDepth.gain.value = cfg.lfoDepthHz;
      lfo.connect(lfoDepth);
      allpasses.forEach(ap => lfoDepth.connect(ap.frequency));
      lfo.start();

      return { clip, input, output, automate: (at, offset) => schedulePhaserSweep(dryGain, wetGain, cfg, clip, at, offset) };
    }
    if (cfg.kind === "washout") {
      // input -> dryGain -----------------\
      //       -> convolver -> wetGain ----- +--> highpass -> output
      // Dry/wet and the highpass cutoff are automated by the same shaped
      // envelope, so this just calls both existing scheduling functions
      // (each reads only the cfg fields it cares about) rather than
      // needing new curve math.
      const input = track(ctx.createGain());
      const output = track(ctx.createGain());
      const dryGain = track(ctx.createGain());
      const wetGain = track(ctx.createGain());
      dryGain.gain.value = 1;
      wetGain.gain.value = 0;
      const convolver = track(ctx.createConvolver());
      convolver.buffer = reverbImpulseBuffer(ctx);
      convolver.normalize = true;
      const filter = track(ctx.createBiquadFilter());
      filter.type = "highpass";
      filter.frequency.value = cfg.fromHz;

      input.connect(dryGain).connect(filter);
      input.connect(convolver).connect(wetGain).connect(filter);
      filter.connect(output);

      return {
        clip, input, output,
        automate: (at, offset) => {
          schedulePhaserSweep(dryGain, wetGain, cfg, clip, at, offset);
          scheduleFxSweep(filter, cfg, clip, at, offset || 0);
        },
      };
    }
    if (cfg.kind === "echo") {
      // input -> dryGain -----------------\
      //       -> delay (with feedback) ---- +--> output
      // Delay time and feedback are fixed (no curve control yet, per
      // "start simple") -- only the dry/wet balance ramps in, so a longer
      // hold on the effect means the repeats increasingly dominate.
      const input = track(ctx.createGain());
      const output = track(ctx.createGain());
      const dryGain = track(ctx.createGain());
      const wetGain = track(ctx.createGain());
      dryGain.gain.value = 1;
      wetGain.gain.value = 0;
      const delay = track(ctx.createDelay(1));
      delay.delayTime.value = cfg.delaySec;
      const feedback = track(ctx.createGain());
      feedback.gain.value = cfg.feedback;

      input.connect(dryGain).connect(output);
      input.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(wetGain).connect(output);

      return { clip, input, output, automate: (at, offset) => schedulePhaserSweep(dryGain, wetGain, cfg, clip, at, offset) };
    }
    // Default: a filter sweep (high/low pass) -- one BiquadFilterNode is
    // both the unit's input and its output.
    const node = track(ctx.createBiquadFilter());
    node.type = cfg.filterType;
    node.frequency.value = cfg.fromHz;
    return { clip, input: node, output: node, automate: (at, offset) => scheduleFxSweep(node, cfg, clip, at, offset || 0) };
  }

  // Every unit this session's live AudioContext has ever built, so the next
  // play() (which rebuilds the whole chain fresh) can tear the old one down
  // first -- otherwise a phaser's LFO oscillator would just keep running
  // forever, one more per play(), since fresh units are never implicitly
  // garbage-collected while still connected to the graph.
  let liveFxChainNodes = [];
  function teardownLiveFxChain() {
    liveFxChainNodes.forEach(n => {
      try { n.disconnect(); } catch (e) {}
      try { if (n.stop) n.stop(); } catch (e) {}
    });
    liveFxChainNodes = [];
  }

  // Builds one unit per FX clip currently on the timeline and wires them in
  // series, ordered by .layer ascending (lowest layer = highest priority =
  // first in the chain = visually topmost). Returns the ordered list;
  // entries[0].input is where the Vocal/Beats mix should connect (or
  // straight to ctx.destination when the list is empty).
  function buildFxChain(ctx) {
    const isLive = ctx === audioCtx;
    if (isLive) teardownLiveFxChain();
    const track = isLive ? (n => { liveFxChainNodes.push(n); return n; }) : (n => n);

    const sorted = [...clips.fx].sort((a, b) => a.layer - b.layer);
    const entries = sorted.map(clip => buildFxUnit(ctx, clip, track));
    for (let i = 0; i < entries.length - 1; i++) entries[i].output.connect(entries[i + 1].input);
    if (entries.length) entries[entries.length - 1].output.connect(ctx.destination);
    return entries;
  }

  function scheduleClip(ctx, dest, clip, at, dur, offsetIntoClipSec) {
    if (clip.isSilence) return; // occupies time in the sequence, produces no sound
    if (clip.songId) { scheduleRealClip(ctx, dest, clip, at, dur, offsetIntoClipSec || 0); return; }
    if (clip.track === "vocal") scheduleVocal(ctx, dest, clip, at, dur);
    else scheduleBeats(ctx, dest, clip, at, dur);
  }

  // Plays a slice of the song's pre-rendered "matched" buffer for this
  // clip's track. clip.sourceStart/sourceEnd are offsets (seconds) into
  // that buffer, set when the section was dropped and adjusted by trimming;
  // offsetIntoClipSec additionally shifts the read point when playback
  // starts partway through the clip (e.g. the playhead was scrubbed into it).
  function scheduleRealClip(ctx, dest, clip, at, dur, offsetIntoClipSec) {
    const song = SONGS.find(s => s.id === clip.songId);
    const buf = song && song._matched.buffers ? song._matched.buffers[clip.track] : null;
    if (!buf) return; // matched audio hasn't finished loading yet -- silent until it does
    const srcOffset = clip.sourceStart + offsetIntoClipSec;
    const playDur = Math.max(0, Math.min(dur, buf.duration - srcOffset));
    if (playDur <= 0) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = clip.volume;
    src.connect(gain).connect(dest);
    src.start(at, srcOffset, playDur);
    scheduledNodes.push(src);
  }

  function scheduleVocal(ctx, dest, clip, at, dur) {
    const cell = 0.5;
    const ratios = [1, 1.25, 1.5, 1.25];
    let t = 0, i = 0;
    while (t < dur) {
      const noteLen = Math.min(cell, dur - t);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = clip.root * ratios[i % ratios.length];
      const start = at + t;
      const peak = 0.2 * clip.volume;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.03);
      gain.gain.linearRampToValueAtTime(peak * 0.6, start + noteLen * 0.6);
      gain.gain.linearRampToValueAtTime(0, start + noteLen);
      osc.connect(gain).connect(dest);
      osc.start(start);
      osc.stop(start + noteLen + 0.02);
      scheduledNodes.push(osc);
      t += cell; i++;
    }
  }

  function scheduleBeats(ctx, dest, clip, at, dur) {
    const cell = 0.5;
    let t = 0;
    while (t < dur) {
      const start = at + t;
      const kOsc = ctx.createOscillator();
      const kGain = ctx.createGain();
      kOsc.type = "sine";
      kOsc.frequency.setValueAtTime(120, start);
      kOsc.frequency.exponentialRampToValueAtTime(45, start + 0.12);
      const peak = 0.35 * clip.volume;
      kGain.gain.setValueAtTime(peak, start);
      kGain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
      kOsc.connect(kGain).connect(dest);
      kOsc.start(start);
      kOsc.stop(start + 0.18);
      scheduledNodes.push(kOsc);

      if (t + cell / 2 < dur) {
        const hatStart = start + cell / 2;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer(ctx);
        const hGain = ctx.createGain();
        const hPeak = 0.12 * clip.volume;
        hGain.gain.setValueAtTime(hPeak, hatStart);
        hGain.gain.exponentialRampToValueAtTime(0.001, hatStart + 0.05);
        src.connect(hGain).connect(dest);
        src.start(hatStart);
        src.stop(hatStart + 0.06);
        scheduledNodes.push(src);
      }
      t += cell;
    }
  }

  // ---------- Real-song audio loading ----------
  // Fetches + decodes one stem file into an AudioBuffer. Decoding doesn't
  // require the context to be running (unlock happens separately, on first
  // touch/Play), so this can safely start before any user gesture.
  function loadAudioBuffer(ctx, url) {
    return fetch(url)
      .then(res => {
        if (!res.ok) throw new Error("Couldn't fetch " + url);
        return res.arrayBuffer();
      })
      .then(ab => ctx.decodeAudioData(ab));
  }

  // The matched stem pair is only ever needed once something is actually
  // dropped onto the timeline, so it's fetched lazily right at that moment
  // rather than paying for it up front. Cached on the song object once
  // loaded, so re-use (a second drop, a re-render) is instant.
  function preloadMatched(song) {
    const slot = song._matched;
    if (slot.promise) return slot.promise;
    slot.state = "loading";
    const ctx = getCtx();
    slot.promise = Promise.all([
      loadAudioBuffer(ctx, song.stems.matched.vocal),
      loadAudioBuffer(ctx, song.stems.matched.beats),
    ]).then(([vocal, beats]) => {
      slot.buffers = { vocal, beats };
      slot.state = "ready";
    }).catch(err => {
      slot.state = "error";
      slot.promise = null; // allow retry
      showJsError("Couldn't load audio for " + song.name + ": " + err.message);
      throw err;
    });
    return slot.promise;
  }

  // Each section has its own tiny pre-sliced native-tempo preview file (see
  // public/audio/<song>/sections/) rather than sharing one whole-song
  // buffer -- a preview always plays a section's exact, never-trimmed
  // window, so there's nothing to gain from the full file and a lot to
  // lose in load time. Cached per section+stem once fetched.
  const sectionPreviewCache = {};
  function loadSectionPreview(song, sec, stemKey) {
    const key = sec.id + ":" + stemKey;
    if (sectionPreviewCache[key]) return sectionPreviewCache[key];
    const url = audioUrl(`audio/${song.folder}/sections/${sec.id}-${stemKey}.mp3`);
    const promise = loadAudioBuffer(getCtx(), url).catch(err => {
      delete sectionPreviewCache[key]; // allow retry
      throw err;
    });
    sectionPreviewCache[key] = promise;
    return promise;
  }

  // Plays a section preview buffer straight through -- it's already exactly
  // that section's audio, start to end, so no offset/duration slicing needed.
  function schedulePreviewBuffer(ctx, dest, buffer, at, volume) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(dest);
    src.start(at);
    scheduledNodes.push(src);
  }

  // ---------- Section preview (tap a chip in the Preview Area) ----------
  // A section is stem-agnostic until it's actually dropped, so previewing it
  // plays both the vocal-style and beats-style synthesis together — the best
  // representation of "what this part of the song sounds like" before you've
  // committed it to a lane.
  let previewChipEl = null;
  let previewTimeoutId = null;

  function stopPreview() {
    if (previewChipEl) {
      previewChipEl.classList.remove("playing");
      const icon = previewChipEl.querySelector(".chip-play-icon");
      if (icon) icon.textContent = "▶";
    }
    previewChipEl = null;
    if (previewTimeoutId) { clearTimeout(previewTimeoutId); previewTimeoutId = null; }
    pause(); // also halts main timeline playback if it happened to be running
  }

  // mode: "both" (Songs tab -- reconstructs the full mix from both stems),
  // "vocal" (Vocals tab), or "beats" (Inst tab). Drag-and-drop into a lane
  // is unaffected by this -- only what tapping previews.
  async function togglePreview(sec, chipEl, mode) {
    const wasThisOne = previewChipEl === chipEl;
    stopPreview();
    if (wasThisOne) return; // tapping the already-playing/loading chip just stops it

    const ctx = await ensureAudioReady();
    if (previewChipEl) return; // a different chip was tapped while we were waiting on resume()

    previewChipEl = chipEl;
    chipEl.classList.add("playing");
    const icon = chipEl.querySelector(".chip-play-icon");

    if (sec.songId) {
      // Real section: each section has its own tiny pre-sliced preview file
      // (native tempo/key, so it sounds like the original before project
      // matching) -- fetch just that, not anything whole-song. Usually
      // resolves fast enough that the "playing" state above covers the gap;
      // the icon only flips to pause once it's actually sounding.
      const song = SONGS.find(s => s.id === sec.songId);
      const stems = [];
      if (mode !== "beats") stems.push("vocal");
      if (mode !== "vocal") stems.push("beats");
      Promise.all(stems.map(stemKey => loadSectionPreview(song, sec, stemKey)))
        .then(buffers => {
          if (previewChipEl !== chipEl) return; // stopped or replaced before this resolved
          const startAt = ctx.currentTime + 0.05;
          buffers.forEach(buf => schedulePreviewBuffer(ctx, ctx.destination, buf, startAt, 0.9));
          if (icon) icon.textContent = "⏸";
          const durSec = buffers[0].duration;
          previewTimeoutId = setTimeout(() => { if (previewChipEl === chipEl) stopPreview(); }, durSec * 1000 + 80);
        })
        .catch(err => {
          if (previewChipEl === chipEl) stopPreview();
          showJsError("Preview failed to load: " + err.message);
        });
      return;
    }

    const fakeClip = { root: sec.root || 220, volume: 0.9 };
    const durSec = barsToSeconds(sec.durBars);
    const startAt = ctx.currentTime + 0.05;
    if (mode !== "beats") scheduleVocal(ctx, ctx.destination, fakeClip, startAt, durSec);
    if (mode !== "vocal") scheduleBeats(ctx, ctx.destination, fakeClip, startAt, durSec);
    if (icon) icon.textContent = "⏸";
    previewTimeoutId = setTimeout(() => {
      if (previewChipEl === chipEl) stopPreview();
    }, durSec * 1000 + 80);
  }

  function timelineEndBars() {
    return Math.max(0.01,
      ...clips.vocal.map(c => c.position + c.duration),
      ...clips.beats.map(c => c.position + c.duration),
      ...clips.fx.map(c => c.position + c.duration));
  }

  function formatTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  // ---------- Transport ----------
  function stopAllNodes() {
    scheduledNodes.forEach(n => { try { n.stop(); } catch (e) {} });
    scheduledNodes = [];
  }

  // True for the entire time a play() call is waiting on the real audio
  // network fetch + decode (see the loading state below) -- guards against
  // a second tap during that window queuing up a whole separate play()
  // run (the button doesn't flip to a pause icon, and thus doesn't look
  // pressed, until scheduling actually happens), which would otherwise
  // race the first one's stopAllNodes()/scheduling against its own.
  let playStarting = false;

  async function play() {
    if (playStarting) return;
    const hasClips = clips.vocal.length > 0 || clips.beats.length > 0;
    if (hasClips) {
      trackFirstInteraction();
      pushAnalyticsEvent("demo_play_pressed");
    }

    // A real clip whose matched audio hasn't finished loading yet would
    // otherwise schedule nothing at all for it, silently (scheduleRealClip
    // just no-ops without a buffer) -- wait for whatever's actually on the
    // timeline right now rather than assuming it's ready. On a first press
    // for a song that hasn't been preloaded yet (or hasn't finished -- the
    // fetch is kicked off at drop time, but a slow/mobile connection can
    // easily outlast however long the user spent arranging clips before
    // hitting Play), this is a real network fetch + decode, not something
    // any amount of local optimization shortens -- so the button shows a
    // spinner for it rather than just sitting there looking unresponsive.
    const songIds = new Set([...clips.vocal, ...clips.beats, ...clips.fx].map(c => c.songId).filter(Boolean));
    const alreadyLoaded = [...songIds].every(id => {
      const song = SONGS.find(s => s.id === id);
      return song && song._matched.state === "ready";
    });
    if (!alreadyLoaded) {
      playStarting = true;
      playBtn.classList.add("loading");
    }
    try {
      const ctx = await ensureAudioReady();
      await Promise.all([...songIds].map(id => {
        const song = SONGS.find(s => s.id === id);
        return song ? preloadMatched(song).catch(() => {}) : null;
      }));
      await playScheduled(ctx);
    } finally {
      playStarting = false;
      playBtn.classList.remove("loading");
    }
  }

  async function playScheduled(ctx) {
    stopAllNodes();
    const end = timelineEndBars();
    if (playheadBar >= end) playheadBar = 0;

    playStartCtxTime = ctx.currentTime + 0.06;
    playStartBar = playheadBar;

    // Fresh node per FX clip every play() call -- nothing to reset between
    // runs, unlike the old single shared filter.
    const fxChain = buildFxChain(ctx);
    const mixDest = fxChain.length ? fxChain[0].input : ctx.destination;

    [...clips.vocal, ...clips.beats].forEach(clip => {
      const clipEndBar = clip.position + clip.duration;
      if (clipEndBar <= playheadBar) return;
      const offsetIntoClipBars = Math.max(0, playheadBar - clip.position);
      const startDelaySec = Math.max(0, barsToSeconds(clip.position - playheadBar));
      const playDurSec = barsToSeconds(clip.duration - offsetIntoClipBars);
      scheduleClip(ctx, mixDest, clip, playStartCtxTime + startDelaySec, playDurSec, barsToSeconds(offsetIntoClipBars));
    });

    fxChain.forEach(({ clip, automate }) => {
      const clipEndBar = clip.position + clip.duration;
      if (clipEndBar <= playheadBar) return;
      const offsetIntoClipBars = Math.max(0, playheadBar - clip.position);
      const startDelaySec = Math.max(0, barsToSeconds(clip.position - playheadBar));
      automate(playStartCtxTime + startDelaySec, barsToSeconds(offsetIntoClipBars));
    });

    isPlaying = true;
    playIcon.innerHTML = '<rect x="6" y="5" width="4" height="14" rx="1" fill="white"></rect><rect x="14" y="5" width="4" height="14" rx="1" fill="white"></rect>';
    tick();
  }

  function pause() {
    isPlaying = false;
    stopAllNodes();
    teardownLiveFxChain(); // stop any phaser LFOs rather than leaving them running silently until the next play()
    playIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="white"></path>';
    if (rafId) cancelAnimationFrame(rafId);
  }

  function seekTo(bar) {
    pause();
    playheadBar = bar;
    updatePlayheadEl();
  }

  function tick() {
    if (!isPlaying) return;
    const ctx = getCtx();
    const elapsedSec = ctx.currentTime - playStartCtxTime;
    playheadBar = playStartBar + Math.max(0, elapsedSec) / BAR_SECONDS;
    updatePlayheadEl();
    if (playheadBar >= timelineEndBars()) {
      pause();
      playheadBar = timelineEndBars();
      updatePlayheadEl();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function updatePlayheadEl() {
    // Offset by the sticky label column width so the playhead starts at the
    // beginning of the actual lane content, not the left edge of the screen.
    playhead.style.left = (LABEL_W + barsToPx(playheadBar)) + "px";
    timeCur.textContent = formatTime(barsToSeconds(playheadBar));
  }

  playBtn.addEventListener("click", () => { isPlaying ? pause() : play(); });
  skipStartBtn.addEventListener("click", () => seekTo(0));
  rewindBtn.addEventListener("click", () => seekTo(Math.max(0, playheadBar - 1)));
  fastFwdBtn.addEventListener("click", () => seekTo(Math.min(timelineEndBars(), playheadBar + 1)));
  locateBtn.addEventListener("click", () => {
    const target = LABEL_W + barsToPx(playheadBar) - scrollArea.clientWidth / 2;
    scrollArea.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  });

  // ---------- Export ----------
  // Renders the full arrangement offline (not real-time) into a single AudioBuffer.
  // Both WAV and MP3 export start from this same buffer — only the encoding differs.
  async function renderArrangement() {
    const endBars = timelineEndBars();
    if (endBars <= 0.02) return null;
    const endSec = barsToSeconds(endBars);
    const sampleRate = 44100;
    const offline = new OfflineAudioContext(2, Math.ceil((endSec + 0.5) * sampleRate), sampleRate);
    const fxChain = buildFxChain(offline);
    const mixDest = fxChain.length ? fxChain[0].input : offline.destination;

    [...clips.vocal, ...clips.beats].forEach(clip => {
      scheduleClip(offline, mixDest, clip, barsToSeconds(clip.position) + 0.05, barsToSeconds(clip.duration));
    });
    fxChain.forEach(({ clip, automate }) => {
      automate(barsToSeconds(clip.position) + 0.05, 0);
    });

    return offline.startRendering();
  }

  // Filenames can't contain <>:"/\|?* (Windows) or control characters, and
  // Windows also rejects a trailing space/dot -- strip those out rather than
  // let a title like "Vocal Chops / Take 2" silently break the download.
  function exportFilename(ext) {
    const cleaned = (titleInput.value || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.\s]+$/, "");
    return `${cleaned || "tuttii-demo-mashup"}.${ext}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function exportWav() {
    exportWavBtn.textContent = "Rendering…";
    exportWavBtn.disabled = true;
    try {
      const rendered = await renderArrangement();
      if (rendered) {
        downloadBlob(audioBufferToWav(rendered), exportFilename("wav"));
        pushAnalyticsEvent("demo_export_clicked");
      }
    } catch (err) {
      console.error(err);
      alert("Export hit a snag in this browser preview — try again.");
    }
    exportWavBtn.textContent = "WAV";
    exportWavBtn.disabled = false;
  }

  // MP3 needs a real encoder — the browser has no built-in one, so this pulls in
  // lamejs (a small, well-established pure-JS encoder) from a CDN the first time
  // it's needed, rather than loading it unconditionally on every page load.
  let lamejsLoading = null;
  function loadLamejs() {
    if (window.lamejs) return Promise.resolve();
    if (lamejsLoading) return lamejsLoading;
    lamejsLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.0/lame.min.js";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Couldn't load the MP3 encoder — check your connection and try again."));
      document.head.appendChild(script);
    });
    return lamejsLoading;
  }

  function floatTo16BitPCM(floatArray) {
    const out = new Int16Array(floatArray.length);
    for (let i = 0; i < floatArray.length; i++) {
      const s = Math.max(-1, Math.min(1, floatArray[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  async function exportMp3() {
    exportMp3Btn.textContent = "Loading…";
    exportMp3Btn.disabled = true;
    try {
      await loadLamejs();
      exportMp3Btn.textContent = "Rendering…";
      const buffer = await renderArrangement();
      if (!buffer) { exportMp3Btn.textContent = "MP3"; exportMp3Btn.disabled = false; return; }

      const left = floatTo16BitPCM(buffer.getChannelData(0));
      const right = buffer.numberOfChannels > 1 ? floatTo16BitPCM(buffer.getChannelData(1)) : null;
      const encoder = new lamejs.Mp3Encoder(buffer.numberOfChannels, buffer.sampleRate, 128);
      const blockSize = 1152;
      const chunks = [];
      for (let i = 0; i < left.length; i += blockSize) {
        const leftChunk = left.subarray(i, i + blockSize);
        const buf = right
          ? encoder.encodeBuffer(leftChunk, right.subarray(i, i + blockSize))
          : encoder.encodeBuffer(leftChunk);
        if (buf.length > 0) chunks.push(buf);
      }
      const tail = encoder.flush();
      if (tail.length > 0) chunks.push(tail);

      downloadBlob(new Blob(chunks, { type: "audio/mp3" }), exportFilename("mp3"));
      pushAnalyticsEvent("demo_export_clicked");
    } catch (err) {
      console.error(err);
      showJsError(err.message || "MP3 export failed — try again.");
    }
    exportMp3Btn.textContent = "MP3";
    exportMp3Btn.disabled = false;
  }

  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataLength = buffer.length * blockAlign;
    const bufferOut = new ArrayBuffer(44 + dataLength);
    const view = new DataView(bufferOut);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, "data");
    view.setUint32(40, dataLength, true);

    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) channelData.push(buffer.getChannelData(ch));

    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = Math.max(-1, Math.min(1, channelData[ch][i]));
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }
    return new Blob([bufferOut], { type: "audio/wav" });
  }

  exportWavBtn.addEventListener("click", exportWav);
  exportMp3Btn.addEventListener("click", exportMp3);

  // ---------- Init ----------
  renderLibrary();
  renderClips();
  commitHistory();
  selectedUid = null;
  document.querySelectorAll(".clip").forEach(el => el.classList.remove("selected"));
  inspector.classList.remove("show");
  updateVolSliderFill();
  updateHistoryButtons();
  updatePlayheadEl();

  // ---------- Iframe-embed auto-height ----------
  // .embedded's CSS (style.css) drops the pinned-shell/internal-scroll
  // layout so this page has one natural height; this reports that height
  // to the parent window on every layout change so the wrapping <iframe>
  // (e.g. tuttii.app/try) can resize to match, instead of clipping a long
  // library short or leaving a dead-space gap under a short one. A
  // ResizeObserver on the whole document catches song expand/collapse, tab
  // switches, inspector open/close, future songs added -- anything that
  // changes layout -- without needing to hook every call site by hand.
  if (document.documentElement.classList.contains("embedded")) {
    let lastReportedHeight = 0;
    function reportEmbedHeight() {
      const h = document.documentElement.scrollHeight;
      if (h === lastReportedHeight) return;
      lastReportedHeight = h;
      window.parent.postMessage({ type: "tuttii-embed-resize", height: h }, "*");
    }
    new ResizeObserver(reportEmbedHeight).observe(document.documentElement);
    window.addEventListener("load", reportEmbedHeight);
    reportEmbedHeight();

    // A wheel/trackpad scroll over an <iframe> is captured by that
    // iframe's own browsing context -- it never chain-scrolls the parent
    // page, even when (as here, in embedded mode) there's nothing left
    // inside to scroll vertically. Left alone, hovering the embed on a
    // laptop just does nothing, which reads as a frozen page. Relay
    // vertical-dominant wheel gestures to the parent instead; horizontal
    // ones (panning the timeline) are left untouched.
    document.addEventListener("wheel", function (e) {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      window.parent.postMessage({ type: "tuttii-embed-scroll", deltaY: e.deltaY }, "*");
    }, { passive: false });
  }

})();
