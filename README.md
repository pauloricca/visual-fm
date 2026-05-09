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

## Run without Docker

Serve the folder from a local web server:

```sh
python3 -m http.server 8839
```

Then open `http://localhost:8839`.
