#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parsePatchFile } from "../src/patch-format.js";
import { normalizePatch } from "../src/patch-normalize.js";

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
const savedPatch = normalizePatch(parsePatchFile(readFileSync(
  resolve(ROOT, "patches/test custom wave/2026-05-17_11-32-32.yaml"),
  "utf8",
)));
engine.setGraph({
  maxVoices: savedPatch.maxVoices,
  nodes: savedPatch.nodes,
  links: savedPatch.links,
  masterEffects: savedPatch.masterEffects,
});
let untriggeredEnvelopePeak = 0;
for (let block = 0; block < 8; block += 1) {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  engine.process([], [[left, right]]);
  untriggeredEnvelopePeak = Math.max(
    untriggeredEnvelopePeak,
    left.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
    right.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
  );
}
if (untriggeredEnvelopePeak > 0.0001) {
  throw new Error("WASM worklet rendered an untriggered audio-output envelope on the drone voice.");
}

engine.resetRuntimeState();
engine.setGraph({
  maxVoices: 1,
  nodes: [
    {
      id: "custom-once",
      wave: "custom",
      frequencyMode: "fixed",
      frequency: 200,
      ratio: 1,
      customWave: {
        mode: "once",
        points: [
          { x: 0, y: 0 },
          { x: 0.25, y: 1 },
          { x: 0.75, y: -1 },
          { x: 1, y: 0 },
        ],
      },
    },
  ],
  links: [
    { id: "custom-out", from: "custom-once", to: "audio", amount: 1, envelope: { release: 0.05 } },
  ],
});

engine.noteOn(60, 1);
let customEarlyPeak = 0;
let customLatePeak = 0;
for (let block = 0; block < 24; block += 1) {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  engine.process([], [[left, right]]);
  const blockPeak = Math.max(
    left.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
    right.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
  );
  if (block < 4) customEarlyPeak = Math.max(customEarlyPeak, blockPeak);
  if (block >= 16) customLatePeak = Math.max(customLatePeak, blockPeak);
}
if (customEarlyPeak <= 0) {
  throw new Error("WASM worklet did not render a custom wave.");
}
if (customLatePeak > customEarlyPeak * 0.1) {
  throw new Error("WASM worklet custom one-shot wave kept looping.");
}
engine.noteOn(62, 1);
let customRetriggerPeak = 0;
for (let block = 0; block < 4; block += 1) {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  engine.process([], [[left, right]]);
  customRetriggerPeak = Math.max(
    customRetriggerPeak,
    left.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
    right.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
  );
}
if (customRetriggerPeak <= customEarlyPeak * 0.25) {
  throw new Error("WASM worklet custom one-shot wave did not restart on a new voice trigger.");
}

engine.resetRuntimeState();
engine.setGraph({
  maxVoices: 1,
  nodes: [
    { id: "drone-mod", wave: "sine", frequencyMode: "fixed", frequency: 1, ratio: 1, speed: 8, audioInputGain: 1 },
    { id: "enveloped-carrier", wave: "saw", frequencyMode: "fixed", frequency: 110, ratio: 1, speed: 8, audioInputGain: 1 },
  ],
  links: [
    { id: "drone-internal", from: "drone-mod", to: "enveloped-carrier", amount: 1, modulationTarget: "phase", drone: true },
    {
      id: "enveloped-out",
      from: "enveloped-carrier",
      to: "audio",
      amount: 1,
      drone: false,
      envelope: { attack: 0.001, decay: 0.01, sustain: 1, release: 0.05 },
    },
  ],
});

engine.nextLinkMeterPostSample = Number.POSITIVE_INFINITY;
engine.process([], [[new Float32Array(128), new Float32Array(128)]]);
const droneInternal = engine.linksById.get("drone-internal");
const droneInternalCount = droneInternal?.wasmIndex >= 0 ? engine.linkMeterCounts?.[droneInternal.wasmIndex] || 0 : 0;
const droneInternalOutput = droneInternal?.wasmIndex >= 0 ? engine.linkMeterOutputSums?.[droneInternal.wasmIndex] || 0 : 0;
if (droneInternalCount <= 0 || droneInternalOutput <= 0) {
  throw new Error("WASM worklet stopped evaluating drone operator links when the audio output link used an envelope.");
}
engine.nextLinkMeterPostSample = 0;

engine.resetRuntimeState();
engine.setGraph({
  maxVoices: 1,
  nodes: [
    { id: "formant-source", wave: "saw", frequencyMode: "fixed", frequency: 110, ratio: 1, speed: 8, audioInputGain: 1 },
  ],
  links: [
    {
      id: "formant-out",
      from: "formant-source",
      to: "audio",
      amount: 1,
      drone: true,
      filter: { type: "formant", cutoff: 0, resonance: 36 },
      envelope: { attack: 0.001, decay: 0.01, sustain: 1, release: 0.05 },
    },
  ],
});

function renderFormantProbeBlock() {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  engine.process([], [[left, right]]);
  return left;
}

for (let block = 0; block < 24; block += 1) renderFormantProbeBlock();
const formantA = renderFormantProbeBlock();
engine.setLinkParam({ id: "formant-out", parameter: "filter.cutoff", value: 1 });
for (let block = 0; block < 24; block += 1) renderFormantProbeBlock();
const formantU = renderFormantProbeBlock();
let formantDiff = 0;
let formantEnergy = 0;
for (let index = 0; index < formantA.length; index += 1) {
  const delta = formantA[index] - formantU[index];
  formantDiff += delta * delta;
  formantEnergy += formantA[index] * formantA[index] + formantU[index] * formantU[index];
}
formantDiff = Math.sqrt(formantDiff / formantA.length);
formantEnergy = Math.sqrt(formantEnergy / (formantA.length * 2));
if (formantEnergy <= 0 || formantDiff < formantEnergy * 0.2) {
  throw new Error("WASM worklet formant morph did not audibly change the rendered signal.");
}

engine.resetRuntimeState();
engine.setGraph({
  maxVoices: 1,
  nodes: [
    { id: "formant-source", wave: "saw", frequencyMode: "fixed", frequency: 110, ratio: 1, speed: 8, audioInputGain: 1 },
    { id: "formant-mod", wave: "sine", frequencyMode: "fixed", frequency: 1, ratio: 1, speed: 8, audioInputGain: 1 },
  ],
  links: [
    {
      id: "modulated-formant-out",
      from: "formant-source",
      to: "audio",
      amount: 1,
      drone: true,
      filter: { type: "formant", cutoff: 0, resonance: 36 },
      envelope: { attack: 0.001, decay: 0.01, sustain: 1, release: 0.05 },
    },
    {
      id: "formant-link-mod",
      from: "formant-mod",
      to: "modulated-formant-out",
      amount: 0,
      modulationTarget: "amplitude",
      drone: true,
    },
  ],
});

for (let block = 0; block < 24; block += 1) renderFormantProbeBlock();
const modulatedFormantA = renderFormantProbeBlock();
engine.setLinkParam({ id: "modulated-formant-out", parameter: "filter.cutoff", value: 1 });
for (let block = 0; block < 24; block += 1) renderFormantProbeBlock();
const modulatedFormantU = renderFormantProbeBlock();
let modulatedFormantDiff = 0;
let modulatedFormantEnergy = 0;
for (let index = 0; index < modulatedFormantA.length; index += 1) {
  const delta = modulatedFormantA[index] - modulatedFormantU[index];
  modulatedFormantDiff += delta * delta;
  modulatedFormantEnergy += modulatedFormantA[index] * modulatedFormantA[index] + modulatedFormantU[index] * modulatedFormantU[index];
}
modulatedFormantDiff = Math.sqrt(modulatedFormantDiff / modulatedFormantA.length);
modulatedFormantEnergy = Math.sqrt(modulatedFormantEnergy / (modulatedFormantA.length * 2));
if (modulatedFormantEnergy <= 0 || modulatedFormantDiff < modulatedFormantEnergy * 0.2) {
  throw new Error("WASM worklet formant morph did not survive link modulation/effective params.");
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
