#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "patches/wasm-vs-js-dense-fm.yaml");
const LANE_COUNT = 96;
const WAVE_TYPES = ["sine", "triangle", "saw", "ramp", "square"];
const COLUMNS = 12;
const X_STEP = 210;
const Y_STEP = 210;
const X_START = 180;
const Y_START = 160;

function round(value, places = 4) {
  return Number(value.toFixed(places));
}

function laneRatio(index, offset = 0) {
  const octave = Math.floor(index / 24) * 0.5;
  const step = ((index * 7 + offset) % 24) / 12;
  return round(0.5 + octave + step, 4);
}

function outputPan(index) {
  const position = (index % COLUMNS) / (COLUMNS - 1);
  return round(position * 2 - 1, 4);
}

function envelope(index) {
  return {
    delay: 0,
    attack: round(0.001 + (index % 4) * 0.001, 4),
    decay: round(0.018 + (index % 5) * 0.004, 4),
    sustain: 1,
    release: round(0.09 + (index % 7) * 0.018, 4),
  };
}

function follower() {
  return { attack: 0.01, release: 0.12 };
}

function filter() {
  return { type: "none", cutoff: 5000, resonance: 0.7 };
}

function nodePair(index) {
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const x = X_START + column * X_STEP;
  const y = Y_START + row * Y_STEP;
  const carrierId = `car-${String(index + 1).padStart(3, "0")}`;
  const modulatorId = `mod-${String(index + 1).padStart(3, "0")}`;
  return [
    {
      id: modulatorId,
      name: `M${String(index + 1).padStart(2, "0")}`,
      x,
      y,
      wave: WAVE_TYPES[(index + 2) % WAVE_TYPES.length],
      frequencyMode: "ratio",
      ratio: laneRatio(index, 5),
      frequency: 440,
      speed: 8,
      audioInputGain: 1,
    },
    {
      id: carrierId,
      name: `C${String(index + 1).padStart(2, "0")}`,
      x,
      y: y + 92,
      wave: WAVE_TYPES[index % WAVE_TYPES.length],
      frequencyMode: "ratio",
      ratio: laneRatio(index, 0),
      frequency: 440,
      speed: 8,
      audioInputGain: 1,
    },
  ];
}

function links(index) {
  const number = String(index + 1).padStart(3, "0");
  const carrierId = `car-${number}`;
  const modulatorId = `mod-${number}`;
  const modulationAmount = round(1.4 + (index % 9) * 0.37, 4);
  const outputAmount = round(0.035 + (index % 4) * 0.004, 4);
  return [
    {
      id: `fm-${number}`,
      from: modulatorId,
      to: carrierId,
      amount: modulationAmount,
      delay: 0,
      noise: 0,
      pan: 0,
      velocitySensitivity: 0,
      modulationTarget: "phase",
      drone: false,
      signalMode: "raw",
      follower: follower(),
      filter: filter(),
      envelope: envelope(index),
    },
    {
      id: `out-${number}`,
      from: carrierId,
      to: "audio",
      amount: outputAmount,
      delay: 0,
      noise: 0,
      pan: outputPan(index),
      velocitySensitivity: 1,
      modulationTarget: "amplitude",
      drone: false,
      signalMode: "raw",
      follower: follower(),
      filter: filter(),
      envelope: envelope(index + 3),
    },
  ];
}

function yamlScalar(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function toYaml(value, indent = 0) {
  const space = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${space}[]`;
    return value.map((item) => `${space}-\n${toYaml(item, indent + 2)}`).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${space}{}`;
    return entries.map(([key, item]) => {
      if (Array.isArray(item) && item.length === 0) return `${space}${key}: []`;
      if (item && typeof item === "object" && Object.keys(item).length === 0) return `${space}${key}: {}`;
      if (item && typeof item === "object") return `${space}${key}:\n${toYaml(item, indent + 2)}`;
      return `${space}${key}: ${yamlScalar(item)}`;
    }).join("\n");
  }
  return `${space}${yamlScalar(value)}`;
}

const patch = {
  patchName: "WASM vs JS Dense FM Benchmark",
  maxVoices: 16,
  audioInputDeviceId: "default",
  audioOutputDeviceId: "default",
  midiChannel: "all",
  midiInputId: "all",
  midiBindings: [],
  masterEffects: {
    chorus: { enabled: false, rate: 0.8, depth: 0.012, mix: 0.25 },
    delay: { enabled: false, time: 0.28, feedback: 0.35, mix: 0.25 },
    reverb: { enabled: false, size: 0.55, decay: 0.45, mix: 0.25 },
  },
  nodes: Array.from({ length: LANE_COUNT }, (_, index) => nodePair(index)).flat(),
  links: Array.from({ length: LANE_COUNT }, (_, index) => links(index)).flat(),
};

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(
  OUTPUT,
  [
    "# Visual FM benchmark patch",
    "# 96 independent two-operator lanes: every carrier goes to Audio Out, every carrier has one phase modulator.",
    "# This matches the current Rust/WASM backend surface while pushing the JS graph renderer hard.",
    toYaml(patch),
    "",
  ].join("\n"),
);

console.log(`Wrote ${OUTPUT}`);
