# Visual FM

A browser-based FM synth patch canvas. Create oscillator nodes, drag from a node output to another node input to add modulation, and drag a node output to the Audio Out anchor to hear it.

The synth uses Web Audio with an AudioWorklet and listens for Web MIDI note on/off messages when the browser supports MIDI. The computer keyboard also plays notes on the lower row as a fallback.

## Run with Docker Compose

Start the containerized server:

```sh
docker compose up --build
```

Then open `http://localhost:8839`.

For the host-side convenience flow that opens the browser automatically:

```sh
./start.sh
```

Containers cannot reliably open the host browser by themselves, so the helper script starts Compose and opens the page from your machine.

## Run on iOS

iOS browsers need a secure context for AudioWorklet. `http://localhost:8839` works only on the same device that is serving the app; if you open the app from an iPhone using `http://<computer-ip>:8839`, audio will be blocked.

Start the HTTPS dev server:

```sh
./start.sh https
```

The script generates local certificates in `.certs/`, serves the app at `https://localhost:8843`, and prints LAN URLs for your iPhone. You can also run the server directly with `node scripts/serve-https.mjs`.

On the iPhone:

1. Open the printed `http://<computer-ip>:8844/visual-fm-dev-root.crt` URL to install the Visual FM dev root certificate.
2. Open Settings, then install the downloaded profile from VPN & Device Management.
3. Open Settings > General > About > Certificate Trust Settings, then enable full trust for "Visual FM Dev Root CA".
4. Open the printed `https://<computer-ip>:8843/` app URL.

## Run without Docker

Serve the folder from a local web server:

```sh
python3 -m http.server 8839
```

Then open `http://localhost:8839`.
