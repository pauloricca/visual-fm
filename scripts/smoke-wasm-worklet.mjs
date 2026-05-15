#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workletSource = readFileSync(resolve(ROOT, "src/audio-worklet-wasm.js"), "utf8");
const wasmBuffer = readFileSync(resolve(ROOT, "src/wasm/visual-fm-kernel.wasm"));
const wasmBytes = wasmBuffer.buffer.slice(
  wasmBuffer.byteOffset,
  wasmBuffer.byteOffset + wasmBuffer.byteLength,
);
let Processor = null;
const messages = [];

const context = vm.createContext({
  console,
  fetch,
  WebAssembly,
  Float32Array,
  Map,
  Math,
  Number,
  Array,
  sampleRate: 48000,
  AudioWorkletProcessor: class {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (message) => messages.push(message),
      };
    }
  },
  registerProcessor: (_name, ctor) => {
    Processor = ctor;
  },
});

vm.runInContext(workletSource, context);

const engine = new Processor({
  processorOptions: {
    wasmBytes,
  },
});

for (let index = 0; index < 20 && !engine.ready; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

if (!engine.ready) {
  throw new Error("WASM worklet did not become ready.");
}

engine.setGraph({
  maxVoices: 4,
  nodes: [
    { id: "op-z", wave: "sine", frequencyMode: "ratio", ratio: 1, frequency: 440 },
    { id: "op-v", wave: "sine", frequencyMode: "ratio", ratio: 1, frequency: 440 },
    { id: "op-w", wave: "sine", frequencyMode: "ratio", ratio: 1.33, frequency: 440 },
    { id: "op-x", wave: "sine", frequencyMode: "ratio", ratio: 1.5, frequency: 440 },
    { id: "op-y", wave: "sine", frequencyMode: "ratio", ratio: 1.75, frequency: 440 },
  ],
  links: [
    { id: "link-z-v", from: "op-z", to: "op-v", amount: 2, modulationTarget: "phase", envelope: { release: 0.2 } },
    { id: "link-z-w", from: "op-z", to: "op-w", amount: 2, modulationTarget: "phase", envelope: { release: 0.2 } },
    { id: "link-z-x", from: "op-z", to: "op-x", amount: 2, modulationTarget: "phase", envelope: { release: 0.2 } },
    { id: "link-z-y", from: "op-z", to: "op-y", amount: 2, modulationTarget: "phase", envelope: { release: 0.2 } },
    { id: "link-v-out", from: "op-v", to: "audio", amount: 0.6, pan: -0.6, envelope: { release: 0.2 } },
    { id: "link-z-v-out-amp", from: "op-z", to: "link-v-out", amount: 0.45, modulationTarget: "amplitude", envelope: { release: 0.2 } },
    { id: "link-w-out", from: "op-w", to: "audio", amount: 0.6, pan: -0.2, envelope: { release: 0.2 } },
    { id: "link-x-out", from: "op-x", to: "audio", amount: 0.6, pan: 0.2, envelope: { release: 0.2 } },
    { id: "link-y-out", from: "op-y", to: "audio", amount: 0.6, pan: 0.6, envelope: { release: 0.2 } },
  ],
});

const syncedLinks = engine.links.filter((link) => link.wasmIndex >= 0).length;
if (syncedLinks !== 9) {
  throw new Error(`Expected 9 links synced into the Rust graph, got ${syncedLinks}.`);
}

const linkModulator = engine.linksById.get("link-z-v-out-amp");
if (!linkModulator || linkModulator.wasmIndex < 0) {
  throw new Error("Expected link-to-link modulation to sync into the Rust graph.");
}

engine.noteOn(60, 1);

let peak = 0;
for (let block = 0; block < 4; block += 1) {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  engine.process([], [[left, right]]);
  peak = Math.max(
    peak,
    left.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
    right.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
  );
}

if (peak <= 0) {
  throw new Error("WASM worklet rendered silence.");
}

const smoothedLink = engine.linksById.get("link-v-out");
const amountBeforeSmooth = smoothedLink.controlSmoother.current.amount;
engine.setLinkParam({ id: "link-v-out", parameter: "amount", value: 0 });
if (smoothedLink.controlSmoother.current.amount !== amountBeforeSmooth) {
  throw new Error("WASM worklet link amount jumped instead of smoothing.");
}
engine.process([], [[new Float32Array(128), new Float32Array(128)]]);
if (!(smoothedLink.controlSmoother.current.amount < amountBeforeSmooth)) {
  throw new Error("WASM worklet link amount smoother did not advance.");
}

engine.resetRuntimeState();
engine.setGraph({
  maxVoices: 1,
  nodes: [
    { id: "line-in", wave: "audio-input", audioInputGain: 1 },
  ],
  links: [
    { id: "line-out", from: "line-in", to: "audio", amount: 1, drone: true, envelope: { release: 0.05 } },
  ],
});

let inputPeak = 0;
for (let block = 0; block < 2; block += 1) {
  const input = new Float32Array(128).fill(0.25);
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  engine.process([[input, input]], [[left, right]]);
  inputPeak = Math.max(
    inputPeak,
    left.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
    right.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
  );
}

if (inputPeak <= 0) {
  throw new Error("WASM worklet did not render audio-input node signal.");
}

engine.resetRuntimeState();
engine.setGraph({
  maxVoices: 1,
  nodes: [
    { id: "delay-in", wave: "audio-input", audioInputGain: 1 },
  ],
  links: [
    { id: "delay-out", from: "delay-in", to: "audio", amount: 1, delay: 64 / 48000, drone: true },
  ],
});

engine.process([[new Float32Array(128), new Float32Array(128)]], [[new Float32Array(128), new Float32Array(128)]]);
const impulse = new Float32Array(128);
impulse[0] = 1;
const delayLeft = new Float32Array(128);
const delayRight = new Float32Array(128);
engine.process([[impulse, impulse]], [[delayLeft, delayRight]]);
const earlyDelayPeak = delayLeft.slice(0, 48).reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const lateDelayPeak = delayLeft.slice(56, 96).reduce((max, value) => Math.max(max, Math.abs(value)), 0);
if (earlyDelayPeak > 0.0001 || lateDelayPeak <= 0) {
  throw new Error("WASM worklet delay line did not delay the impulse as expected.");
}

engine.resetRuntimeState();
engine.setGraph({
  maxVoices: 1,
  nodes: [
    { id: "trigger-in", wave: "audio-input", audioInputGain: 1 },
  ],
  links: [
    { id: "triggered-out", from: "trigger-in", to: "audio", amount: 1, drone: true, envelope: { attack: 0.001, decay: 0.01, sustain: 1, release: 0.05 } },
    { id: "trigger-mod", from: "trigger-in", to: "triggered-out", amount: 1, modulationTarget: "envelopeTrigger", drone: true },
  ],
});

const gatedLeft = new Float32Array(128);
engine.process([[new Float32Array(128), new Float32Array(128)]], [[gatedLeft, new Float32Array(128)]]);
const gatedPeak = gatedLeft.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const triggerInput = new Float32Array(128).fill(1);
const triggeredLeft = new Float32Array(128);
engine.process([[triggerInput, triggerInput]], [[triggeredLeft, new Float32Array(128)]]);
const triggeredPeak = triggeredLeft.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
if (gatedPeak > 0.0001 || triggeredPeak <= 0) {
  throw new Error("WASM worklet envelope trigger did not gate and retrigger the target link.");
}

engine.resetRuntimeState();
engine.setGraph({
  maxVoices: 1,
  masterEffects: {
    delay: { enabled: true, time: 0.02, feedback: 0, mix: 1 },
  },
  nodes: [
    { id: "master-delay-in", wave: "audio-input", audioInputGain: 1 },
  ],
  links: [
    { id: "master-delay-out", from: "master-delay-in", to: "audio", amount: 1, drone: true },
  ],
});

const masterImpulse = new Float32Array(128);
masterImpulse[0] = 1;
let masterEarlyPeak = 0;
let masterLatePeak = 0;
for (let block = 0; block < 10; block += 1) {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  const input = block === 0 ? masterImpulse : new Float32Array(128);
  engine.process([[input, input]], [[left, right]]);
  const blockPeak = left.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (block < 6) masterEarlyPeak = Math.max(masterEarlyPeak, blockPeak);
  if (block >= 7) masterLatePeak = Math.max(masterLatePeak, blockPeak);
}

if (masterEarlyPeak > 0.0001 || masterLatePeak <= 0) {
  throw new Error("WASM worklet master delay effect did not delay the impulse as expected.");
}

const reportedReady = messages.some((message) => message.type === "backendStatus" && message.payload?.ready);
if (!reportedReady) {
  throw new Error("WASM worklet did not post a ready backendStatus message.");
}

console.log(`WASM worklet smoke passed; peak=${peak.toFixed(5)}`);
