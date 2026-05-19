# Visual FM

A browser-based FM synth patch canvas. Create oscillator nodes, drag from a node output to another node input to add modulation, and drag a node output to the Audio Out anchor to hear it.

The synth uses Web Audio with an AudioWorklet and listens for Web MIDI note on/off messages when the browser supports MIDI. The computer keyboard also plays notes on the lower row as a fallback.

## Run with Docker Compose

Start the containerized server:

```sh
docker compose up --build
```

Then open `http://localhost:8839`.

## Audio engine

The default engine is the Rust WASM-backed AudioWorklet. To force the JavaScript AudioWorklet, open:

```sh
http://localhost:8839/?engine=js
```

You can also switch between `Rust WASM` and `JS AudioWorklet` from the Patch panel. The WASM engine syncs a compact node/link graph into Rust and renders recursive node modulation for `phase`, `frequency`, `ring`, `fold`, and `mix` targets, plus link-to-link modulation, link ADSR envelopes and triggers, smoothed live link controls, velocity scaling, noise, signal followers, link filters, bounded link delay, extra oscillator waves, audio-input nodes, and the master chorus/delay/reverb effects.

The WASM delay pool is intentionally bounded so dense benchmark patches do not allocate huge multi-second buffers for every link; use the JavaScript engine for full-length experimental delay patches.

The WASM kernel source lives in `rust/visual-fm-kernel` and is built in Docker, so no local Rust toolchain is required. Rebuild and smoke-test the checked-in WASM kernel with:

```sh
sh scripts/build-rust-wasm.sh
node scripts/smoke-wasm-worklet.mjs
```

For a heavier current-backend benchmark, load `patches/wasm-vs-js-dense-fm.yaml`. It contains 96 independent two-operator FM lanes, with 192 nodes and 192 links, and is designed to stress the JavaScript graph renderer while staying inside the Rust/WASM spike's supported feature set.

You can also run a headless JS-vs-WASM render benchmark against that patch:

```sh
node scripts/benchmark-engines.mjs
```

For the convenience flow that starts both HTTP and HTTPS and opens the browser automatically:

```sh
./start.sh
```

The helper script starts Docker Compose and opens the HTTP app URL from your machine. Use `./start.sh local` to run the same combined HTTP/HTTPS server directly with Node.

## Run on iOS

iOS browsers need a secure context for AudioWorklet. `http://localhost:8839` works only on the same device that is serving the app; if you open the app from an iPhone using `http://<computer-ip>:8839`, audio will be blocked.

Start the combined HTTP/HTTPS dev server:

```sh
./start.sh
```

The script generates local certificates in `.certs/`, serves the app at `http://localhost:8839` and `https://localhost:8843`, and prints LAN URLs for your iPhone. You can also run the server directly with `node scripts/serve.mjs`.

On the iPhone:

1. Open the printed `http://<computer-ip>:8844/visual-fm-dev-root.crt` URL to install the Visual FM dev root certificate.
2. Open Settings, then install the downloaded profile from VPN & Device Management.
3. Open Settings > General > About > Certificate Trust Settings, then enable full trust for "Visual FM Dev Root CA".
4. Open the printed `https://<computer-ip>:8843/` app URL.

## Run without Docker

Serve the folder from a local web server:

```sh
node scripts/serve.mjs
```

Then open `http://localhost:8839`.
