# Visual FM Agent Guide

This file is the fast orientation layer for AI/coding agents. Read it before
digging through the source tree.

## What This Project Is

Visual FM is a browser-based FM synth patch canvas. Users create oscillator
nodes, connect node outputs to other nodes or Audio Out, edit link modulation
parameters, play via Web MIDI or the on-screen/computer keyboard, and save/load
patches from local disk through the dev server.

The app is intentionally framework-free:

- Static HTML in `index.html`.
- Browser UI/state/orchestration in `src/app.js`.
- Styling in `src/styles.css`.
- Shared data constants/defaults in `src/constants.js`.
- Patch validation/migration in `src/patch-normalize.js`.
- Patch import/export text format in `src/patch-format.js`.
- JavaScript AudioWorklet backend in `src/audio-worklet.js`.
- Rust/WASM AudioWorklet wrapper in `src/audio-worklet-wasm.js`.
- Rust DSP kernel in `rust/visual-fm-kernel/src/lib.rs`.
- Local HTTP/HTTPS server and save APIs in `scripts/`.

There is no package manager setup and no build step for normal frontend edits.

## Mental Model

The patch is the source of truth. `src/app.js` owns a mutable `state` object that
looks like:

```js
{
  patchName,
  maxVoices,
  audioInputDeviceId,
  audioOutputDeviceId,
  audioOutPosition,
  linkSignalGradientMeters,
  midiChannel,
  midiInputId,
  keyboardStartNote,
  keyboardLength,
  midiBindings,
  masterEffects,
  nodes,
  links,
}
```

Nodes are operators/signal sources. Links are both cables and modulation units.
A link can target:

- a node id, meaning node modulation,
- `"audio"`, meaning output to the master audio path,
- another link id, meaning link-to-link modulation.

`normalizePatch()` is the schema gate. Any saved/imported/default patch should
flow through `src/patch-normalize.js` before use. If you add a patch field,
update normalization first, then UI, then backend graph sync.

## Runtime Flow

1. `index.html` loads `src/app.js` as a module.
2. `app.js` loads a patch from localStorage or `defaultPatch`.
3. UI render functions create DOM for nodes, wires, panel controls, MIDI
   bindings, keyboard/knob panels, and modals.
4. User edits mutate `state`, call render/schedule helpers, save to
   localStorage, and send graph or parameter updates to the audio backend.
5. `ensureAudio()` creates an `AudioContext`, loads the selected AudioWorklet,
   and creates the processor node.
6. The processor receives:
   - `{ type: "graph", payload }` for complete graph sync.
   - `{ type: "linkParam", payload }` for smoothed live link changes.
   - `{ type: "noteOn" | "noteOff" | "panic", payload }` for performance.
7. Worklets post meters/status back to `app.js`; UI paints wire/link meters.

## Audio Backends

The default backend is Rust WASM. The JavaScript worklet is still important as a
reference implementation and fallback.

Backend selection is in `src/app.js`:

- `AUDIO_BACKENDS.js` uses `src/audio-worklet.js`.
- `AUDIO_BACKENDS.wasm` uses `src/audio-worklet-wasm.js` plus
  `src/wasm/visual-fm-kernel.wasm`.
- Query string `?engine=js` forces the JS engine.
- The Patch panel can switch engines at runtime.

Both backends should accept the same `graphPayload()` shape from `app.js`.
When adding audio features, keep these layers aligned:

1. Constants/options in `src/constants.js`.
2. Patch normalization in `src/patch-normalize.js`.
3. UI controls/rendering in `src/app.js`.
4. `graphPayload()` and live `sendLinkParam()` behavior in `src/app.js`.
5. JS worklet behavior in `src/audio-worklet.js`.
6. WASM wrapper ids/mapping in `src/audio-worklet-wasm.js`.
7. Rust kernel fields/targets/rendering in `rust/visual-fm-kernel/src/lib.rs`.
8. Smoke/benchmark scripts if behavior affects backend parity.

The WASM path has bounded pools and fixed-size arrays for real-time safety.
Respect limits such as max nodes/links/custom-wave points/delay slots in Rust.

## UI Architecture

`src/app.js` is large but organized by feature bands:

- DOM references and constants near the top.
- Patch load/save, counters, selection, MIDI binding utilities.
- Canvas coordinate math, wire geometry, graph posting.
- Audio/MIDI setup and runtime messaging.
- Render functions for nodes, wires, panels, modals, bottom controls.
- Event handlers for dragging, linking, marquee selection, zoom/pan, keyboard.

The DOM is not declarative. UI changes usually mean:

1. Add/adjust HTML skeleton only if a persistent root element is needed.
2. Add styles in `src/styles.css`.
3. Render dynamic markup in the appropriate `render...()` function.
4. Attach events after render, usually near existing event wiring helpers.
5. Mutate `state`, then call `schedulePatchSave()`, `sendGraph()` or
   `sendLinkParam()`, and the relevant render/schedule helper.

Avoid introducing a framework unless the project direction explicitly changes.

## Patch File Format

Patch files are YAML-like text with an embedded base64 JSON header:

```text
# Visual FM patch
# visual-fm-json: ...
patchName: "..."
```

`parsePatchFile()` prefers the embedded JSON header, then JSON, then the simple
YAML parser. `patchFileText()` writes both human-readable YAML-ish content and
the lossless JSON header. Saved patches live under `patches/<patch name>/`.

The server-side save API intentionally sanitizes patch names and timestamps in
`scripts/app-handler.mjs`; keep that path traversal protection intact.

## Local Server And Storage

Run options:

```sh
node scripts/serve.mjs
docker compose up --build
./start.sh
./start.sh local
```

Ports:

- HTTP app: `8839`
- HTTPS app: `8843`
- iOS root certificate helper: `8844`

The HTTPS server generates local certs in `.certs/` for iOS AudioWorklet secure
context requirements. Saved patches go to `patches/`; recordings go to
`recordings/`.

## Verification Commands

For normal frontend-only edits:

```sh
node scripts/serve.mjs
```

For WASM/audio backend edits:

```sh
sh scripts/build-rust-wasm.sh
node scripts/smoke-wasm-worklet.mjs
node scripts/benchmark-engines.mjs
```

`scripts/build-rust-wasm.sh` uses Docker, so a local Rust toolchain is not
required. It writes `src/wasm/visual-fm-kernel.wasm`.

## Common Change Recipes

### Add a node wave type

Update wave constants/defaults, normalize node wave values, add UI labels, add
JS worklet oscillator behavior, add WASM wrapper id mapping, add Rust wave id
rendering, then smoke-test both engines.

### Add a link parameter

Add default/ranges in constants and normalization, expose the panel control,
include it in graph payload/link param updates, smooth it if it changes live,
support it in both worklets, and include it in MIDI parameter definitions if it
should be MIDI-controllable.

### Add a modulation target

Update `NODE_MODULATION_TARGETS` or `LINK_MODULATION_TARGETS`, normalization,
labels/options in `app.js`, JS backend target handling, WASM target id mapping,
and Rust target constants/render application.

### Add a patch-level setting

Add it to `defaultPatch`, `normalizePatch()`, `currentPatchData()`, relevant UI
rendering, localStorage/save/load flows, and `graphPayload()` if the audio
engine needs it.

### Add a server endpoint

Add it in `scripts/app-handler.mjs`. Use existing helpers for JSON responses,
body limits, safe paths, and no-store caching. Keep static file serving locked to
non-dot paths inside the project root.

## Important Constraints And Conventions

- Keep browser modules as plain ES modules.
- Prefer existing helpers (`clamp`, `clonePatch`, normalization functions,
  render/schedule helpers) over new abstractions.
- Do not bypass `normalizePatch()` for imported/saved patch data.
- Avoid blocking or allocating heavily in AudioWorklet `process()` paths.
- Keep JS and WASM backend behavior intentionally parallel.
- Treat `src/audio-worklet.js` as both a backend and useful executable spec for
  the Rust/WASM backend.
- Do not hand-edit generated `src/wasm/visual-fm-kernel.wasm`; rebuild it from
  Rust.
- Be careful with `patches/` and `recordings/`; they may contain user-created
  content.
- The app uses pointer events and disables normal page touch behavior for canvas
  ergonomics; test touch/mouse interactions after canvas changes.

## First Files To Read For A Task

- App behavior or UI: `src/app.js`, then `src/styles.css`.
- Data model or saved patch issues: `src/constants.js`,
  `src/patch-normalize.js`, `src/patch-format.js`.
- Audio rendering bug: `src/audio-worklet.js`, `src/audio-worklet-wasm.js`,
  `rust/visual-fm-kernel/src/lib.rs`.
- Dev server/save/load bug: `scripts/app-handler.mjs`,
  `scripts/serve-https.mjs`.
- Run instructions/user-facing overview: `README.md`.
