#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parsePatchFile } from "../src/patch-format.js";
import { normalizePatch } from "../src/patch-normalize.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_RATE = 48000;
const BLOCK_SIZE = 128;
const WARMUP_BLOCKS = 40;
const BENCH_BLOCKS = Number.isFinite(Number(process.argv[3]))
  ? Math.max(1, Math.round(Number(process.argv[3])))
  : 120;
const PATCH_PATH = process.argv[2] || "patches/wasm-vs-js-dense-fm.yaml";

function wasmBytes() {
  const buffer = readFileSync(resolve(ROOT, "src/wasm/visual-fm-kernel.wasm"));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function loadProcessor(sourcePath) {
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
    Set,
    sampleRate: SAMPLE_RATE,
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

  vm.runInContext(readFileSync(resolve(ROOT, sourcePath), "utf8"), context);
  if (!Processor) throw new Error(`Could not load processor from ${sourcePath}`);
  return { Processor, messages };
}

async function waitUntilReady(engine) {
  if (engine.ready !== false) return;
  for (let index = 0; index < 50 && !engine.ready; index += 1) {
    await new Promise((resolveReady) => setTimeout(resolveReady, 10));
  }
  if (!engine.ready) throw new Error("WASM engine did not become ready.");
}

async function createEngine(kind) {
  const sourcePath = kind === "wasm" ? "src/audio-worklet-wasm.js" : "src/audio-worklet.js";
  const { Processor } = loadProcessor(sourcePath);
  const engine = kind === "wasm"
    ? new Processor({ processorOptions: { wasmBytes: wasmBytes() } })
    : new Processor();
  await waitUntilReady(engine);
  return engine;
}

function send(engine, type, payload) {
  engine.port.onmessage?.({ data: { type, payload } });
}

function processBlocks(engine, count) {
  let peak = 0;
  const start = performance.now();
  for (let block = 0; block < count; block += 1) {
    const left = new Float32Array(BLOCK_SIZE);
    const right = new Float32Array(BLOCK_SIZE);
    engine.process([], [[left, right]]);
    for (let index = 0; index < BLOCK_SIZE; index += 1) {
      peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
    }
  }
  return { elapsedMs: performance.now() - start, peak };
}

async function benchmark(kind, patch) {
  const engine = await createEngine(kind);
  send(engine, "graph", patch);
  send(engine, "noteOn", { note: 60, velocity: 1 });
  processBlocks(engine, WARMUP_BLOCKS);
  const result = processBlocks(engine, BENCH_BLOCKS);
  send(engine, "noteOff", { note: 60 });
  return result;
}

const patch = normalizePatch(parsePatchFile(readFileSync(resolve(ROOT, PATCH_PATH), "utf8")));
const blockDurationMs = (BLOCK_SIZE / SAMPLE_RATE) * 1000;

console.log(`Benchmark patch: ${PATCH_PATH}`);
console.log(`${patch.nodes.length} nodes, ${patch.links.length} links, ${BENCH_BLOCKS} blocks`);

for (const kind of ["js", "wasm"]) {
  process.stdout.write(`${kind.padEnd(4)} running...`);
  const { elapsedMs, peak } = await benchmark(kind, patch);
  const perBlock = elapsedMs / BENCH_BLOCKS;
  const realtime = (perBlock / blockDurationMs) * 100;
  process.stdout.write(`\r${kind.padEnd(4)} ${perBlock.toFixed(3)} ms/block, ${realtime.toFixed(1)}% realtime block, peak=${peak.toFixed(5)}\n`);
}
