# Moving the Tuttii Mini Editor to Claude Code

This is your onboarding guide — what Claude Code is, how to start, and a full spec of every decision baked into the prototype so Claude Code doesn't have to guess or reinvent anything.

---

## 1. What Claude Code actually is

Everything we've built so far lives in **this chat** — a single HTML file with no persistent storage, no real file system, no ability to run a dev server, and no version control. That's been fine for fast iteration, but it's a dead end for a real build.

**Claude Code is a different tool** — it runs on your actual computer (via a terminal, a desktop app, or an IDE extension) and works directly in a real project folder. It can:
- Create and edit many files, not just one
- Install real npm packages (audio libraries, a build tool, etc.)
- Run a local dev server so you can see changes live
- Use git for version history
- Read your actual AudioShake stem files from disk

Think of it as the difference between sketching on a napkin (this chat) and sitting down at a real desk with real tools (Claude Code). The napkin was the right call for figuring out the interaction — now you need the desk.

**How to get it:** go to [claude.com/claude-code](https://claude.com/claude-code) for install instructions. It's a command-line tool at its core; there's also a desktop app if you'd rather not touch a terminal. If you get stuck on installation itself, that's a good first question to ask Claude Code (or me) directly.

---

## 2. How to start the project

1. Create a new folder on your computer for this project (e.g. `tuttii-mini-editor`).
2. Put the `tuttii-mini-editor.html` file from this chat into that folder.
3. Open a terminal in that folder and run `claude` (or open the folder in the Claude Code desktop app).
4. Your first prompt should tell Claude Code what this file is and what you want. Something like:

> "This HTML file is a working prototype of a browser-based mini music editor, built and tested in a chat environment. It uses synthesized placeholder audio and a hardcoded 2-song library. I want to turn this into a real project: swap the placeholder audio for real audio files, structure it as a proper multi-file web project, and make it easy to add more songs. Read through the file first, then propose a project structure before writing any code."

That last sentence matters — let it read and think before it starts generating files. It's much better at this when it has full context first.

---

## 3. What to bring with you

- **The HTML file itself** (already in this folder)
- **This guide** (put it in the same folder — tell Claude Code to read it first, alongside the HTML file)
- **Your AudioShake-exported stems** — you'll need vocal + instrumental stems for at least the 2–3 songs you want in the real demo, ideally already trimmed to the sections you want (Intro/Verse/Chorus, etc.), and pre-matched to a single common key/BPM the same way the demo assumes (see Section 5)

You do **not** need to bring Charley or his codebase into this — nothing here touches Tuttii's real stem-separation or key-matching engine. This is a standalone demo that only needs the *already-processed* stems as static files.

---

## 4. The one real engineering decision left

Right now, key and BPM are locked (shown grayed out with "Locked for demo" copy) so every song plays back cleanly without needing real-time pitch/tempo matching in the browser. That was a deliberate scope decision, not a limitation of the code. Before Claude Code writes anything, decide:

- **Keep it locked** (recommended for a first real version) — just swap in real audio pre-matched to one key/BPM, same as the placeholder synth audio is now. Fastest path to something real and functional.
- **Add real key/BPM matching** — meaningfully bigger scope: needs a pitch-shifting/time-stretching library in the browser (e.g. SoundTouch.js-style approaches), and quality won't match Tuttii's real backend. Only worth it if proving that specific capability is the point of this demo.

If you're not sure, tell Claude Code to build the locked version first and treat matching as a clearly separate phase 2.

---

## 5. Full spec — decisions already made, don't relitigate these

Everything below was worked out through real back-and-forth in this chat and verified working. Give this section to Claude Code directly so it inherits the reasoning, not just the code.

### Data model
- Each track (Vocal, Beats) is an **ordered array** of clips. A clip's timeline position is never stored directly — it's always *derived* by summing the durations of everything before it in the array (`layout()` function). This is what guarantees clips can never have gaps or overlaps from reordering or dropping.
- Sections in the library are **stem-agnostic**: the same "Verse 1" chip becomes a vocal clip or a beats clip depending on which lane it's dropped into. Nothing about the section itself is vocal- or beats-specific until drop time.
- Units are **bars**, not seconds, throughout. Audio scheduling converts bars → seconds only at the point of scheduling (`BAR_SECONDS = (60/BPM) × 4`). Trim/extend snaps to **whole bars** — this was an explicit requirement, not a default.

### Drag and drop
- Library chips use custom pointer-event handling (not native HTML5 drag-and-drop, which doesn't work reliably on mobile). Touch is claimed immediately on `pointerdown` (not mid-gesture) — this was a real bug fix; waiting to claim the touch let mobile Safari's native scroll win the gesture before the app's own logic got a chance.
- A tap (no meaningful movement) on a section chip **previews** that section's audio; a drag places it. A tap on an *already-placed* clip opens its inspector (volume/duplicate/delete); dragging it *reorders* it in the sequence.
- Dropping a new section decides its position by comparing the drop point to the midpoint of whatever existing clip it lands near — past the midpoint = insert after; before = insert before.

### Trim behavior (this took several iterations — see it through before changing it)
- **Right handle:** grows/shrinks this clip's duration. The clip's start never moves. Everything after it in the sequence shifts to stay flush (`layout()` handles this automatically).
- **Left handle:** mechanically identical to the right handle — duration changes, start position **never moves** — just triggered by the opposite drag direction. Dragging the left handle further left *grows* the duration (pushing the clip's *end* further right, and everything after it along with it). The only thing that's conceptually "backward" about it is which part of the source stem it represents exposing — not anything about where the clip sits on the timeline. **Clips must never overlap or leave gaps, in any trim direction.**

### Silence blocks
- A separate "Silence" section in the library (1/2/4 bar options), draggable into either lane like any other section. Produces no scheduled audio but occupies real timeline space, so it's the only sanctioned way to create a deliberate gap in an otherwise-flush sequence.

### Other locked decisions
- **Export:** WAV (native) and MP3 (via a lazily-loaded `lamejs` from CDN, only fetched on first use) — both render the full arrangement offline via `OfflineAudioContext`, not a live recording.
- **Undo/redo:** full history snapshots after every committed action, including Reset (Reset is itself an undoable action, not a destructive dialog).
- **Scrub bar:** press-and-drag anywhere in the Scrub row to seek, not just tap — the whole row is the hit target, not just the thin playhead line.
- **The "Get Tuttii" CTA and the locked BPM/Key styling are intentional product framing**, not placeholders — they're the whole point of the demo (show the mechanic, then drive the download).

---

## 6. Swapping in real audio — the actual work

The placeholder audio lives in two functions, `scheduleVocal()` and `scheduleBeats()`, which currently generate a synthesized arpeggio and a kick/hat pattern respectively using the Web Audio API's oscillators — no real audio files at all. The swap is:

1. Preload each stem file with `fetch()` + `AudioContext.decodeAudioData()` into an `AudioBuffer`, once, at load time.
2. Replace the oscillator-based scheduling with `AudioBufferSourceNode`, using the decoded buffer, an offset into it (which part of the stem to start from), and a duration.
3. Everything else — the timeline, drag/trim/reorder logic, export, undo/redo — doesn't need to change at all. It was built to schedule "some audio for N seconds starting at time T," which is exactly what a real buffer source needs too.

Ask Claude Code to make this swap as an isolated first step, and confirm it plays correctly, before touching anything else — it's the highest-value, lowest-risk change to make first.

---

## 7. One thing worth testing early

Late in this chat's testing, I found something odd I couldn't fully explain: dragging the *same* library chip onto the timeline twice in a row occasionally behaved unexpectedly in my automated testing tool, but I couldn't reproduce it as a real bug and suspect it was a testing-tool artifact rather than a real one. Worth a quick manual sanity check early in Claude Code — drag the same section chip onto the timeline several times in a row and confirm it behaves correctly every time. If it doesn't, that's a real bug worth chasing; if it does, it was noise.

---

## 8. Where to go after it's working locally

Once Claude Code has it running well on your machine, deploying it is a small step — a static site host like Vercel or Netlify can serve this directly (drag-and-drop deploy, or connect a GitHub repo for auto-deploy on push). Ask Claude Code to set that up once you're happy with the local version; it's a much smaller task than everything above.
