# Clip Studio 2.0

Link in, client-ready short-form clips out.

## Setting up a fresh machine

```bash
git clone git@github.com:cokezero256/clip-studio.git
cd clip-studio
npm install
cp .env.example .env        # then fill in the API keys
```

Needs Node 22+, ffmpeg comes vendored (`ffmpeg-static`, the one with libass), and the
Xcode command-line tools for the two small Swift helpers (`swiftc`; the title renderer
rebuilds itself from `packages/engine/bin/src`). `data/` is created on first run and is never
committed — sources, proxies, renders and the SQLite database live there per machine. The
caption fonts ship in the repo (`packages/engine/config/captions/fonts`); Sequel Sans is a
licensed font — keep the repo private.

## Running it

Two processes. The **web app** only reads and writes database rows; the **worker** owns
every ffmpeg / yt-dlp / whisper child process. That separation is the point — v1 ran the
pipeline inside the Next request handler, so a render outlived its own HTTP request and
cancelling could only kill every ffmpeg on the machine.

```bash
# terminal 1 — the worker
npm run worker

# terminal 2 — the dashboard
npm run dev          # http://localhost:3040
```

Both must be running. If the worker is down, jobs queue up and simply never start.

## What it does today

Paste a YouTube / livestream / Instagram link (or a local file path) → the worker
downloads it, transcribes locally with whisper.cpp, finds candidate clips, removes the
silence, renders vertical clips with burned-in captions, and verifies each finished file.

**The silence guarantee is machine-checked on the rendered MP4**, not on the transcript —
whisper's word timings are interpolated and will happily report a 160ms gap where the audio
has 1.6 seconds of dead air. Every clip card shows its gate results; click *Why*.

**Framing is automatic.** A single 16:9 recording containing both a webcam and a
screen-share is re-composed into a filled 9:16 frame — chart on top, trader below — rather
than letterboxed into a thin strip. Detection is temporal-variance based (a talking person
moves continuously, a chart doesn't) and needs no ML dependency.

## Outlier gallery — `/outliers`

Scrapes the tracked trading pages, scores every post against its OWN page, downloads the
performers, reads the burned-in title off the video, and classifies the format. Run it from
the gallery's **Refresh corpus** button, or queue a job of type `outliers`.

Three things about it are non-obvious and deliberate:

**Scoring uses the median, not the mean.** Views are log-normal, so a page's mean sits
around its 67th percentile and dividing by it makes a typical post score *below* 1.0. The
score is a robust z in log space — `mu = median(ln views)`, `sigma = 1.4826 x MAD` — and the
gallery displays `views / exp(mu)`, i.e. "4.1x this page's typical reel", because a
multiplier is legible and a z-score isn't. Posts younger than five days are scored but never
flagged; they haven't finished accumulating views.

**Titles are read off the pixels.** Instagram captions on these pages are worthless —
measured on rp.profits they are literally "Crazy", "True", "Sauce". The hook is burned into
the frame. OCR is macOS Vision via a small Swift helper rather than tesseract or a vision
model, because separating the title from rolling captions needs BOUNDING BOXES: both sit in
a fixed position, but the title's wording stays stable while captions change every second.

**The classifier needs telling that a chart beats a face.** Asked to classify a split-screen
trading reel, it will call it a talking head because the face is prominent — even with a
chart filling two thirds of the frame. The prompt states the rule explicitly, and
`isTargetFormat()` trusts `chart_share` over the label as a safety net. When it is still
wrong, correct it in the detail sheet: a hand-set label overrides the model permanently.

Cheap signals were tried and do not work — every rp.profits post is 1080x1920 with a junk
caption, so aspect, duration and caption carry no signal at all.

## Layout

```
packages/engine   the render core, lifted from VIDEO EDITOR/lib and extended
                    ingest.js        yt-dlp, with an extractor-strategy fallback chain
                    outliers/        scrape, score, OCR titles, classify format
                    transcribe.js    whisper.cpp, word timestamps, no 25MB ceiling
                    select/          signals, candidates, boundaries, gates, measurement
                    compose/         webcam/screen detection + 9:16 re-composition
                    motion/          sendcmd keyframe compiler for pan/zoom
                    capabilities.js  refuses to start on an ffmpeg without libass
packages/db       SQLite schema + queries (jobs, sources, clips, renders, events)
apps/worker       claims jobs, runs the pipeline, streams events
apps/web          Next 16 dashboard on :3040 (/ = clipper, /outliers = gallery)
data/             clipstudio.db + media
```

## Tests

```bash
npm test --workspace=@clip-studio/engine   # inherited smoke suite (caption-sync invariant)
node packages/engine/src/__tests.js        # 2.0 suite: gates, motion, boundaries, captions
```

## Known limits

- **Source resolution.** YouTube currently serves only low-resolution formats to the one
  yt-dlp extractor client that still permits downloads; the default client lists 1080p but
  403s on the data. The pipeline warns when a source arrives under 720p. `brew upgrade
  yt-dlp` usually restores it. Local files and Instagram reels are unaffected.
- Clip *ranking* is still deterministic signals only — the grounded LLM pass and the
  outlier corpus that would feed it are not built yet.
- No music, no CTA append, no keyframe editing UI yet. The keyframe compiler exists and is
  tested; nothing drives it from the interface.
- Clip titles must be typed. Generating them automatically needs the outlier corpus to
  learn the pattern from, which is why the gallery came first.
- The corpus does not yet feed clip selection. That wiring is the next step: retrieve
  similar outliers per candidate and rank against them, including the flops.

## The editor (per clip)

Every clip card has an **Edit** button → `/clips/<id>`. Four surfaces edit one document:

- **Transcript** (left): click a word to jump; drag across words (or shift-click) to select
  a run — the same words light up on the timeline — then ⌫ cuts the footage under them and
  `H` hides just their captions; double-click fixes what the caption says; click a struck
  word to restore its cut.
- **Stage** (middle): the 1080×1920 canvas at any size. Click the title or the captions to
  select them, drag to move, pull the corner grip to resize; a floating toolbar changes
  size and colour. Band formats show the source frame; the eight re-composed formats draw
  the detected webcam/chart panes onto a canvas from the very rectangles the export crops
  (`packages/engine/src/compose/pane-geometry.js`).
- **Inspector** (right): Format (all 12 layouts as schematics) · Title (text, font, size,
  colours, box, outline, how long it stays) · Captions (word-by-word or highlight, font,
  size, colours, case).
- **Timeline** (bottom, in EDITED time — what you see is what the export plays): a Title
  track (drag its end to set how long the headline stays), a Words track (every caption word
  as a block — drag a block to move it, drag the boundary between two words to change when
  the next caption appears), a Video track (kept footage as clips with filmstrip thumbnails;
  trim the edges, `S` splits at the playhead, click a clip to select it, drag across clips
  for a marquee, ⇧-click to add, ⌫ deletes every selected clip, the red dots between clips
  are removed footage — click one to bring it back) and an Audio track (the kept waveform).
  Scrubbing lives on the ruler. ⌘-wheel zooms around the pointer; snapping is on by default.

Keys: Space play · S split · ⌫ delete · ← → one frame (⇧ ten) · J K L · ⌘Z ⇧⌘Z · ⌘S · ⌘E export
· Esc deselect. Everything autosaves (two tabs on one clip → a Reload / Overwrite dialog).
**Export** saves, then renders the document in one ffmpeg pass (~8 s); the toast carries the
silence gate's verdict, and the result appears on the dashboard card with a Download link.

**Dead air.** Pauses are measured from a 10 ms RMS envelope relative to the speaker's own
level (`packages/engine/src/select/pauses.js`), never from sample peaks — a keyboard click
used to split a silence into pieces too short to cut and leave word-less slivers between
cuts. The planner uses it, a new clip's document opens already tightened, and the timeline's
**Tighten pauses** (with the longest pause to keep) does the same for any document; dead air
above the limit is tinted orange on the audio track. Deleting words also removes the pause
next to them. Caption word boundaries inside continuous speech snap to a clear energy dip
(align v3, `captions/align.js`) — whisper places them ~50–80 ms early.

The webcam/chart regions behind a re-composed format are detected **per clip, at the
clip's own moment** (`clip.composition_json`, worker job `locate-panes`) — a stream's layout
moves during a session, so one detection per source framed the wrong corner.

The preview and the export read the same composition document (`clip.edit_json`, see
`packages/engine/src/edit/doc.js`): the title in the preview IS the PNG the export
overlays, and the caption events are computed by the same code (`captions/phrases.js`).

### Worker restart rule

The worker caches the engine's modules when it starts. **After changing anything under
`packages/engine` or `apps/worker`, restart it** — the editor shows an amber banner when
the running worker is older than the code, and exports from a stale worker will not match
the preview. Two ffmpeg binaries exist on this machine; only the vendored one has libass
(`packages/engine/src/capabilities.js` refuses to start with the other).

### Outlier gallery

`/outliers` — add a trading account from the header (handle or URL; it scrapes right
away), tag reels with the **+** on a card (tags are saved and filter the gallery), and
correct a wrong format from a reel's detail sheet. Media state is re-derived from disk
every time the worker starts, so a billing failure in classification can never empty the
gallery again.
