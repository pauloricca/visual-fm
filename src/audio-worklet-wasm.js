const MAX_WASM_FRAMES = 2048;
const TWO_PI = Math.PI * 2;
const LEFT_OFFSET = 0;
const RIGHT_OFFSET = 8192;
const MAX_ACTIVE_VOICES = 16;
const DRONE_SLOT = MAX_ACTIVE_VOICES;
const AUDIO_TARGET = -1;
const LINK_TARGET_BASE = -2;
const MASTER_GAIN = 0.18;
const VOICE_START_FADE_SECONDS = 0.006;
const VOICE_STEAL_FADE_SECONDS = 0.03;
const LINK_CONTROL_SMOOTH_SECONDS = 0.012;
const LINK_CONTROL_SETTLE_EPSILON = 1e-7;
const LINK_METER_POST_SECONDS = 1 / 30;
const MASTER_DC_BLOCK_HZ = 10;
const DENORMAL_EPSILON = 1e-20;
const FORMANT_INTENSITY_MAX = 36;
const MAX_CUSTOM_WAVE_POINTS = 64;
const QUANTISE_MIDI_ROOT = "midi-note";

const WAVE_IDS = new Map([
  ["sine", 0],
  ["triangle", 1],
  ["saw", 2],
  ["ramp", 3],
  ["square", 4],
  ["sample-hold", 5],
  ["noise", 6],
  ["perlin", 7],
  ["audio-input", 8],
  ["custom", 9],
  ["sample", 10],
]);

const MODULATION_TARGET_IDS = new Map([
  ["phase", 0],
  ["frequency", 1],
  ["wave", 5],
  ["phaseResetTrigger", 6],
  ["ring", 2],
  ["fold", 3],
  ["mix", 4],
  ["amplitude", 10],
  ["pan", 11],
  ["noise", 12],
  ["delay", 13],
  ["envelopeTrigger", 14],
  ["envelope.delay", 15],
  ["envelope.attack", 16],
  ["envelope.decay", 17],
  ["envelope.sustain", 18],
  ["envelope.release", 19],
  ["filterCutoff", 20],
  ["filterResonance", 21],
  ["distortionGain", 22],
  ["sampleTrigger", 23],
  ["sampleStart", 24],
  ["sampleEnd", 25],
  ["sampleStretch", 26],
]);

const SIGNAL_MODE_IDS = new Map([
  ["raw", 0],
  ["envelope", 1],
  ["inverted-envelope", 2],
]);

const FILTER_TYPE_IDS = new Map([
  ["none", 0],
  ["lowpass", 1],
  ["highpass", 2],
  ["bandpass", 3],
  ["formant", 4],
  ["comb", 5],
  ["comb-notch", 6],
]);
const DISTORTION_TYPE_IDS = new Map([
  ["hard-clip", 1],
  ["soft-clip", 2],
  ["fuzz", 3],
  ["saturate", 4],
  ["wavefold", 5],
]);
const CUSTOM_WAVE_MODE_IDS = new Map([
  ["loop", 0],
  ["once", 1],
  ["ping-pong", 2],
  ["sustain", 3],
  ["sustain-loop", 4],
  ["sustain-ping-pong", 5],
]);
const SAMPLE_MODE_IDS = new Map([
  ["one-shot", 0],
  ["loop", 1],
  ["ping-pong", 2],
]);
const DEFAULT_CUSTOM_WAVE = Object.freeze({
  mode: "loop",
  sustainStart: 0.5,
  sustainEnd: 0.75,
  points: Object.freeze([
    Object.freeze({ x: 0, y: 0 }),
    Object.freeze({ x: 1, y: 0 }),
  ]),
});
const QUANTISE_ROOT_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const QUANTISE_SCALE_IDS = new Map([
  ["chromatic", 0],
  ["major", 1],
  ["minor", 2],
  ["major-pentatonic", 3],
  ["minor-pentatonic", 4],
  ["blues", 5],
  ["dorian", 6],
  ["mixolydian", 7],
  ["harmonic-minor", 8],
]);

class VisualFmWasmEngine extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    this.nodes = [];
    this.nodesById = new Map();
    this.links = [];
    this.linksById = new Map();
    this.sampleDataByNodeId = new Map();
    this.linkControlSmoothers = new Map();
    this.activeLinkControlSmoothers = new Set();
    this.hasActiveDroneLinks = false;
    this.maxVoices = 5;
    this.voices = new Map();
    this.activeVoicesByNote = new Map();
    this.pendingVoiceStarts = [];
    this.voiceCounter = 1;
    this.freeSlots = Array.from({ length: MAX_ACTIVE_VOICES }, (_, index) => index);
    this.sampleCursor = 0;
    this.nextLinkMeterPostSample = 0;
    this.lastOutputPeak = 0;
    this.lastProcessFrames = 128;
    this.ready = false;
    this.muted = false;
    this.zeroVoicePhasesOnStart = false;
    this.wasm = null;
    this.leftBuffer = null;
    this.rightBuffer = null;
    this.inputBuffer = null;
    this.linkMeterInputSums = null;
    this.linkMeterOutputSums = null;
    this.linkMeterEnvelopeSums = null;
    this.linkMeterCounts = null;
    this.masterEffects = this.normalizeEffects();
    this.chorusBuffers = [
      new Float32Array(Math.ceil(sampleRate * 0.08)),
      new Float32Array(Math.ceil(sampleRate * 0.08)),
    ];
    this.chorusIndices = [0, 0];
    this.chorusPhases = [0, Math.PI * 0.5];
    this.delayBuffers = [
      new Float32Array(Math.ceil(sampleRate * 1.6)),
      new Float32Array(Math.ceil(sampleRate * 1.6)),
    ];
    this.delayIndices = [0, 0];
    this.reverbDelays = [this.createReverbDelays(), this.createReverbDelays()];
    this.inputDcBlockers = [this.createDcBlocker(), this.createDcBlocker()];
    this.outputDcBlockers = [this.createDcBlocker(), this.createDcBlocker()];

    this.port.onmessage = (event) => {
      const { type, payload } = event.data || {};
      if (type === "graph") {
        this.setGraph(payload);
      } else if (type === "sampleData") {
        this.setSampleData(payload);
      } else if (type === "nodeParam") {
        this.setNodeParam(payload);
      } else if (type === "linkParam") {
        this.setLinkParam(payload);
      } else if (type === "noteOn") {
        if (!this.muted) this.noteOn(payload.note, payload.velocity);
      } else if (type === "noteOff") {
        this.noteOff(payload.note);
      } else if (type === "panic") {
        this.resetRuntimeState();
      } else if (type === "setMuted") {
        this.setMuted(Boolean(payload?.muted));
      }
    };

    this.loadWasm(options.processorOptions || {});
  }

  async loadWasm({ wasmBytes, wasmUrl } = {}) {
    try {
      let bytes = wasmBytes;
      if (!bytes) {
        if (!wasmUrl || typeof fetch !== "function") {
          throw new Error("Missing WASM kernel bytes.");
        }
        const response = await fetch(wasmUrl);
        if (!response.ok) {
          throw new Error(`Could not fetch WASM kernel (${response.status}).`);
        }
        bytes = await response.arrayBuffer();
      }
      const { instance } = await WebAssembly.instantiate(bytes, {});
      this.wasm = instance.exports;
      const leftOffset = typeof this.wasm.leftPtr === "function" ? this.wasm.leftPtr() : LEFT_OFFSET;
      const rightOffset = typeof this.wasm.rightPtr === "function" ? this.wasm.rightPtr() : RIGHT_OFFSET;
      this.leftBuffer = new Float32Array(this.wasm.memory.buffer, leftOffset, MAX_WASM_FRAMES);
      this.rightBuffer = new Float32Array(this.wasm.memory.buffer, rightOffset, MAX_WASM_FRAMES);
      if (typeof this.wasm.inputPtr === "function") {
        this.inputBuffer = new Float32Array(this.wasm.memory.buffer, this.wasm.inputPtr(), MAX_WASM_FRAMES);
      }
      if (
        typeof this.wasm.linkMeterInputPtr === "function"
        && typeof this.wasm.linkMeterOutputPtr === "function"
        && typeof this.wasm.linkMeterEnvelopePtr === "function"
        && typeof this.wasm.linkMeterCountPtr === "function"
      ) {
        this.linkMeterInputSums = new Float64Array(this.wasm.memory.buffer, this.wasm.linkMeterInputPtr(), 1024);
        this.linkMeterOutputSums = new Float64Array(this.wasm.memory.buffer, this.wasm.linkMeterOutputPtr(), 1024);
        this.linkMeterEnvelopeSums = new Float64Array(this.wasm.memory.buffer, this.wasm.linkMeterEnvelopePtr(), 1024);
        this.linkMeterCounts = new Uint32Array(this.wasm.memory.buffer, this.wasm.linkMeterCountPtr(), 1024);
      }
        this.wasm.resetPhases();
      this.ready = true;
      this.syncRustGraph();
      for (const link of this.links) {
        link.controlSmoother = this.syncLinkControlSmoother(link, true);
        this.applyLinkControlSmoother(link);
      }
      this.port.postMessage({ type: "backendStatus", payload: { backend: "wasm", ready: true } });
    } catch (error) {
      this.port.postMessage({
        type: "backendStatus",
        payload: { backend: "wasm", ready: false, error: error?.message || "WASM failed to load." },
      });
    }
  }

  setGraph(graph = {}) {
    this.nodes = (graph.nodes || []).map((node) => this.normalizeNode(node));
    this.nodesById = new Map(this.nodes.map((node) => [node.id, node]));
    this.links = (graph.links || []).map((link) => this.normalizeLink(link));
    this.linksById = new Map(this.links.map((link) => [link.id, link]));
    const linkModulations = new Map();
    for (const link of this.links) {
      if (!this.linksById.has(link.to)) continue;
      const modulators = linkModulations.get(link.to) || [];
      modulators.push(link);
      linkModulations.set(link.to, modulators);
    }
    for (const link of this.links) {
      link.hasEnvelopeTriggers = (linkModulations.get(link.id) || [])
        .some((modLink) => modLink.modulationTarget === "envelopeTrigger");
    }
    const linkIds = new Set(this.links.map((link) => link.id));
    for (const id of this.linkControlSmoothers.keys()) {
      if (!linkIds.has(id)) {
        this.linkControlSmoothers.delete(id);
        this.activeLinkControlSmoothers.delete(id);
      }
    }
    this.maxVoices = this.clamp(Math.round(Number(graph.maxVoices) || 5), 1, MAX_ACTIVE_VOICES);
    this.masterEffects = this.normalizeEffects(graph.masterEffects);
    this.hasActiveDroneLinks = this.links.some((link) => link.drone || link.hasEnvelopeTriggers);
    this.syncRustGraph();
    for (const link of this.links) {
      link.controlSmoother = this.syncLinkControlSmoother(link, true);
      this.applyLinkControlSmoother(link);
    }
    this.enforceVoiceLimit();
  }

  normalizeNode(node = {}) {
    const ratio = Number(node.ratio);
    const frequency = Number(node.frequency);
    const speed = Number(node.speed);
    const audioInputGain = Number(node.audioInputGain);
    const quantiseGlide = Number(node.quantise?.glide);
    return {
      id: node.id,
      wave: WAVE_IDS.has(node.wave) ? node.wave : "sine",
      frequencyMode: node.frequencyMode === "fixed" ? "fixed" : "ratio",
      ratio: Number.isFinite(ratio) ? this.clamp(ratio, 0, 16) : 1,
      frequency: Number.isFinite(frequency) ? this.clamp(frequency, 0, Math.min(12000, sampleRate * 0.45)) : 440,
      quantise: {
        enabled: Boolean(node.quantise?.enabled),
        root: node.quantise?.root === QUANTISE_MIDI_ROOT || QUANTISE_ROOT_NOTES.includes(node.quantise?.root) ? node.quantise.root : "C",
        scale: QUANTISE_SCALE_IDS.has(node.quantise?.scale) ? node.quantise.scale : "chromatic",
        glide: Number.isFinite(quantiseGlide) ? this.clamp(quantiseGlide, 0, 4) : 0,
      },
      speed: Number.isFinite(speed) ? this.clamp(speed, 0.01, 60) : 8,
      audioInputGain: Number.isFinite(audioInputGain) ? this.clamp(audioInputGain, 0, 4) : 1,
      customWave: this.normalizeCustomWave(node.customWave),
      sample: this.normalizeSample(node.sample),
    };
  }

  normalizeSample(sample = {}) {
    const start = Number(sample.start);
    const end = Number(sample.end);
    const stretch = Number(sample.stretch);
    const cycleLength = Number(sample.cycleLength);
    const overlapRatio = Number(sample.overlapRatio);
    const originalPitch = Number(sample.originalPitch);
    return {
      name: sample.name || "",
      sampleRate: Number.isFinite(Number(sample.sampleRate)) ? Math.max(1, Number(sample.sampleRate)) : sampleRate,
      mode: SAMPLE_MODE_IDS.has(sample.mode) ? sample.mode : "one-shot",
      start: Number.isFinite(start) ? this.clamp(start, 0, 1) : 0,
      end: Number.isFinite(end) ? this.clamp(end, 0, 1) : 1,
      stretch: Number.isFinite(stretch) ? Math.max(0.001, stretch) : 1,
      cycleLength: Number.isFinite(cycleLength) ? Math.max(1, Math.round(cycleLength)) : 4096,
      overlapRatio: Number.isFinite(overlapRatio) ? this.clamp(overlapRatio, 0, 1) : 0.09,
      originalPitch: Number.isFinite(originalPitch) ? this.clamp(originalPitch, 0, 127) : 60,
    };
  }

  normalizeCustomWave(customWave = {}) {
    const customWaveModes = new Set(["loop", "once", "ping-pong", "sustain", "sustain-loop", "sustain-ping-pong"]);
    const sourceMode = customWave.mode || customWave.playback;
    const mode = customWaveModes.has(sourceMode) ? sourceMode : DEFAULT_CUSTOM_WAVE.mode;
    const sustainStart = Number.isFinite(Number(customWave.sustainStart))
      ? this.clamp(Number(customWave.sustainStart), 0, 0.999)
      : DEFAULT_CUSTOM_WAVE.sustainStart;
    const sustainEnd = Number.isFinite(Number(customWave.sustainEnd))
      ? this.clamp(Number(customWave.sustainEnd), sustainStart + 0.001, 1)
      : Math.max(sustainStart + 0.001, DEFAULT_CUSTOM_WAVE.sustainEnd);
    const sourcePoints = Array.isArray(customWave.points) ? customWave.points : DEFAULT_CUSTOM_WAVE.points;
    const pointsByX = new Map();
    for (const point of sourcePoints) {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pointsByX.set(this.clamp(x, 0, 1), this.clamp(y, -1, 1));
    }
    pointsByX.set(0, 0);
    pointsByX.set(1, 0);
    const points = [...pointsByX.entries()]
      .map(([x, y]) => ({ x, y }))
      .sort((a, b) => a.x - b.x);
    const cappedPoints = points.length > MAX_CUSTOM_WAVE_POINTS
      ? [...points.slice(0, MAX_CUSTOM_WAVE_POINTS - 1), points[points.length - 1]]
      : points;
    return {
      mode,
      sustainStart,
      sustainEnd,
      points: cappedPoints,
    };
  }

  normalizeLink(link = {}) {
    const amount = Number(link.amount);
    const delay = Number(link.delay);
    const noise = Number(link.noise);
    const pan = Number(link.pan);
    const velocitySensitivity = Number(link.velocitySensitivity);
    const envelopeDelay = Number(link.envelope?.delay);
    const attack = Number(link.envelope?.attack);
    const decay = Number(link.envelope?.decay);
    const sustain = Number(link.envelope?.sustain);
    const release = Number(link.envelope?.release);
    const followerAttack = Number(link.follower?.attack);
    const followerRelease = Number(link.follower?.release);
    const filterCutoff = Number(link.filter?.cutoff);
    const filterResonance = Number(link.filter?.resonance);
    const isComb = link.filter?.type === "comb" || link.filter?.type === "comb-notch";
    const distortionGain = Number(link.distortion?.gain);
    return {
      id: link.id,
      from: link.from,
      to: link.to,
      amount: Number.isFinite(amount) ? this.clamp(amount, 0, 32) : 0,
      delay: Number.isFinite(delay) ? this.clamp(delay, 0, 3) : 0,
      noise: Number.isFinite(noise) ? this.clamp(noise, 0, 1) : 0,
      pan: Number.isFinite(pan) ? this.clamp(pan, -1, 1) : 0,
      velocitySensitivity: Number.isFinite(velocitySensitivity) ? this.clamp(velocitySensitivity, -8, 8) : 0,
      modulationTarget: link.modulationTarget || "phase",
      drone: Boolean(link.drone),
      signalMode: SIGNAL_MODE_IDS.has(link.signalMode) ? link.signalMode : "raw",
      follower: {
        attack: Number.isFinite(followerAttack) ? this.clamp(followerAttack, 0.001, 2) : 0.01,
        release: Number.isFinite(followerRelease) ? this.clamp(followerRelease, 0.001, 4) : 0.12,
      },
      filter: {
        type: FILTER_TYPE_IDS.has(link.filter?.type) ? link.filter.type : "none",
        cutoff: link.filter?.type === "formant"
          ? this.clamp(Number.isFinite(filterCutoff) ? filterCutoff : 0, 0, 1)
          : Number.isFinite(filterCutoff) ? this.clamp(filterCutoff, 20, Math.min(isComb ? 5000 : 12000, sampleRate * 0.45)) : isComb ? 440 : 5000,
        resonance: Number.isFinite(filterResonance)
          ? this.clamp(filterResonance, isComb ? -0.98 : 0.1, link.filter?.type === "formant" ? FORMANT_INTENSITY_MAX : isComb ? 0.98 : 12)
          : isComb ? 0.45 : 0.7,
      },
      distortion: {
        enabled: Boolean(link.distortion?.enabled),
        type: DISTORTION_TYPE_IDS.has(link.distortion?.type) ? link.distortion.type : "soft-clip",
        gain: Number.isFinite(distortionGain) ? this.clamp(distortionGain, 0.1, 40) : 1.5,
      },
      envelope: {
        delay: Number.isFinite(envelopeDelay) ? this.clamp(envelopeDelay, 0, 4) : 0,
        attack: Number.isFinite(attack) ? this.clamp(attack, 0.001, 4) : 0.01,
        decay: Number.isFinite(decay) ? this.clamp(decay, 0.001, 4) : 0.16,
        sustain: Number.isFinite(sustain) ? this.clamp(sustain, 0, 1) : 0.72,
        release: Number.isFinite(release) ? this.clamp(release, 0.001, 6) : 0.24,
      },
    };
  }

  syncRustGraph() {
    if (!this.wasm?.clearGraph) return;

    this.wasm.clearGraph();
    this.wasm.clearLinkMeters?.();
    for (const node of this.nodes) {
      node.wasmIndex = this.wasm.addNode(
        this.waveId(node),
        this.frequencyModeId(node),
        node.ratio,
        node.frequency,
        node.quantise.enabled ? 1 : 0,
        node.quantise.root === QUANTISE_MIDI_ROOT ? -1 : QUANTISE_ROOT_NOTES.indexOf(node.quantise.root),
        QUANTISE_SCALE_IDS.get(node.quantise.scale) ?? 0,
        node.quantise.glide,
        node.speed,
        node.audioInputGain,
        CUSTOM_WAVE_MODE_IDS.get(node.customWave?.mode) ?? 0,
        node.customWave?.sustainStart ?? 0.5,
        node.customWave?.sustainEnd ?? 0.75,
        SAMPLE_MODE_IDS.get(node.sample?.mode) ?? 0,
        node.sample?.start ?? 0,
        node.sample?.end ?? 1,
        node.sample?.stretch ?? 1,
        node.sample?.cycleLength ?? 4096,
        node.sample?.overlapRatio ?? 0.09,
        node.sample?.originalPitch ?? 60,
      );
      if (node.wasmIndex >= 0 && node.wave === "custom" && typeof this.wasm.addCustomWavePoint === "function") {
        for (const point of node.customWave.points) {
          this.wasm.addCustomWavePoint(node.wasmIndex, point.x, point.y);
        }
      }
      this.copySampleDataToWasm(node);
    }

    this.links.forEach((link, index) => {
      link.syncIndex = index;
    });

    for (const link of this.links) {
      const from = this.nodesById.get(link.from)?.wasmIndex ?? -1;
      let to = AUDIO_TARGET;
      let hasValidTarget = false;
      if (link.to === "audio") {
        to = AUDIO_TARGET;
        hasValidTarget = true;
      } else if (this.nodesById.has(link.to)) {
        to = this.nodesById.get(link.to).wasmIndex;
        hasValidTarget = to >= 0;
      } else if (this.linksById.has(link.to)) {
        const targetIndex = this.linksById.get(link.to).syncIndex;
        to = Number.isInteger(targetIndex) ? LINK_TARGET_BASE - targetIndex : AUDIO_TARGET;
        hasValidTarget = Number.isInteger(targetIndex);
      }
      link.wasmIndex = from >= 0 && hasValidTarget
        ? this.wasm.addLink(
          from,
          to,
          link.amount,
          link.delay || 0,
          link.noise || 0,
          link.pan || 0,
          MODULATION_TARGET_IDS.get(link.modulationTarget) ?? 0,
          link.velocitySensitivity || 0,
          link.drone ? 1 : 0,
          SIGNAL_MODE_IDS.get(link.signalMode) ?? 0,
          link.follower?.attack || 0.01,
          link.follower?.release || 0.12,
          FILTER_TYPE_IDS.get(link.filter?.type) ?? 0,
          link.filter?.cutoff ?? 5000,
          link.filter?.resonance || 0.7,
          link.distortion?.enabled ? DISTORTION_TYPE_IDS.get(link.distortion?.type) ?? 2 : 0,
          link.distortion?.gain || 1.5,
          link.envelope?.delay || 0,
          link.envelope?.attack || 0.01,
          link.envelope?.decay || 0.16,
          link.envelope?.sustain ?? 0.72,
          link.envelope?.release || 0.24,
        )
        : -1;
    }
    this.wasm.armCustomOnceTriggers?.(DRONE_SLOT);
  }

  setSampleData(payload = {}) {
    if (!payload.nodeId) return;
    const data = payload.data instanceof Float32Array
      ? payload.data
      : Float32Array.from(Array.isArray(payload.data) ? payload.data : []);
    this.sampleDataByNodeId.set(payload.nodeId, {
      data,
      sampleRate: Number.isFinite(Number(payload.sampleRate)) ? Math.max(1, Number(payload.sampleRate)) : sampleRate,
      name: payload.name || "",
      storageKey: payload.storageKey || "",
    });
    const node = this.nodesById.get(payload.nodeId);
    if (node) this.copySampleDataToWasm(node);
  }

  copySampleDataToWasm(node) {
    if (!this.wasm || node?.wave !== "sample" || node.wasmIndex < 0) return;
    const entry = this.sampleDataByNodeId.get(node.id);
    if (!entry?.data?.length || typeof this.wasm.setSampleData !== "function" || typeof this.wasm.sampleDataPtr !== "function") return;
    const maxFrames = typeof this.wasm.maxSampleFrames === "function" ? this.wasm.maxSampleFrames() : entry.data.length;
    const length = Math.min(entry.data.length, Math.max(0, maxFrames || 0));
    if (!length) return;
    const slot = this.wasm.setSampleData(node.wasmIndex, entry.sampleRate || sampleRate, length);
    if (slot < 0) return;
    const ptr = this.wasm.sampleDataPtr(slot);
    if (!ptr) return;
    new Float32Array(this.wasm.memory.buffer, ptr, length).set(entry.data.subarray(0, length));
  }

  setNodeParam({ id, parameter, value } = {}) {
    const node = this.nodesById.get(id);
    if (!node || node.wasmIndex < 0) return;
    if (parameter === "frequencyMode") {
      node.frequencyMode = value === "fixed" ? "fixed" : "ratio";
      this.wasm?.setNodeFrequencyMode?.(node.wasmIndex, this.frequencyModeId(node));
    } else if (parameter === "ratio") {
      node.ratio = this.clamp(Number(value) || 0, 0, 16);
      this.wasm?.setNodeRatio?.(node.wasmIndex, node.ratio);
    } else if (parameter === "frequency") {
      node.frequency = this.clamp(Number(value) || 0, 0, Math.min(12000, sampleRate * 0.45));
      this.wasm?.setNodeFrequency?.(node.wasmIndex, node.frequency);
    } else if (parameter === "quantise.enabled") {
      node.quantise.enabled = Boolean(value);
      this.wasm?.setNodeQuantiseEnabled?.(node.wasmIndex, node.quantise.enabled ? 1 : 0);
    } else if (parameter === "quantise.root") {
      node.quantise.root = value === QUANTISE_MIDI_ROOT || QUANTISE_ROOT_NOTES.includes(value) ? value : "C";
      this.wasm?.setNodeQuantiseRoot?.(
        node.wasmIndex,
        node.quantise.root === QUANTISE_MIDI_ROOT ? -1 : QUANTISE_ROOT_NOTES.indexOf(node.quantise.root),
      );
    } else if (parameter === "quantise.scale") {
      node.quantise.scale = QUANTISE_SCALE_IDS.has(value) ? value : "chromatic";
      this.wasm?.setNodeQuantiseScale?.(node.wasmIndex, QUANTISE_SCALE_IDS.get(node.quantise.scale) ?? 0);
    } else if (parameter === "quantise.glide") {
      node.quantise.glide = this.clamp(Number(value) || 0, 0, 4);
      this.wasm?.setNodeQuantiseGlide?.(node.wasmIndex, node.quantise.glide);
    } else if (parameter === "speed") {
      node.speed = this.clamp(Number(value) || 8, 0.01, 60);
      this.wasm?.setNodeSpeed?.(node.wasmIndex, node.speed);
    } else if (parameter === "audioInputGain") {
      node.audioInputGain = this.clamp(Number(value) || 1, 0, 4);
      this.wasm?.setNodeAudioInputGain?.(node.wasmIndex, node.audioInputGain);
    } else if (parameter === "sample.mode") {
      node.sample.mode = SAMPLE_MODE_IDS.has(value) ? value : "one-shot";
      this.wasm?.setNodeSampleMode?.(node.wasmIndex, SAMPLE_MODE_IDS.get(node.sample.mode) ?? 0);
    } else if (parameter === "sample.start") {
      node.sample.start = this.clamp(Number(value) || 0, 0, 1);
      this.wasm?.setNodeSampleStart?.(node.wasmIndex, node.sample.start);
    } else if (parameter === "sample.end") {
      node.sample.end = this.clamp(Number(value) || 0, 0, 1);
      this.wasm?.setNodeSampleEnd?.(node.wasmIndex, node.sample.end);
    } else if (parameter === "sample.stretch") {
      node.sample.stretch = Math.max(0.001, Number(value) || 1);
      this.wasm?.setNodeSampleStretch?.(node.wasmIndex, node.sample.stretch);
    } else if (parameter === "sample.cycleLength") {
      node.sample.cycleLength = Math.max(1, Math.round(Number(value) || 4096));
      this.wasm?.setNodeSampleCycleLength?.(node.wasmIndex, node.sample.cycleLength);
    } else if (parameter === "sample.overlapRatio") {
      node.sample.overlapRatio = this.clamp(Number(value) || 0, 0, 1);
      this.wasm?.setNodeSampleOverlapRatio?.(node.wasmIndex, node.sample.overlapRatio);
    } else if (parameter === "sample.originalPitch") {
      node.sample.originalPitch = this.clamp(Number(value) || 60, 0, 127);
      this.wasm?.setNodeSampleOriginalPitch?.(node.wasmIndex, node.sample.originalPitch);
    }
  }

  setLinkParam({ id, parameter, value } = {}) {
    const link = this.linksById.get(id);
    if (!link) return;
    if (parameter === "amount") {
      link.amount = this.clamp(Number(value) || 0, 0, 32);
    } else if (parameter === "delay") {
      link.delay = this.clamp(Number(value) || 0, 0, 3);
    } else if (parameter === "noise") {
      link.noise = this.clamp(Number(value) || 0, 0, 1);
    } else if (parameter === "pan") {
      link.pan = this.clamp(Number(value) || 0, -1, 1);
    } else if (parameter === "velocitySensitivity") {
      link.velocitySensitivity = this.clamp(Number(value) || 0, -8, 8);
      if (this.wasm?.setLinkVelocitySensitivity && link.wasmIndex >= 0) {
        this.wasm.setLinkVelocitySensitivity(link.wasmIndex, link.velocitySensitivity);
      }
    } else if (parameter === "filter.cutoff") {
      const isComb = link.filter.type === "comb" || link.filter.type === "comb-notch";
      link.filter.cutoff = link.filter.type === "formant"
        ? this.clamp(Number.isFinite(Number(value)) ? Number(value) : 0, 0, 1)
        : this.clamp(Number(value) || (isComb ? 440 : 5000), 20, Math.min(isComb ? 5000 : 12000, sampleRate * 0.45));
      if (link.filter.type === "formant" && this.wasm?.setLinkFilterCutoff && link.wasmIndex >= 0) {
        this.wasm.setLinkFilterCutoff(link.wasmIndex, link.filter.cutoff);
      }
    } else if (parameter === "filter.resonance") {
      const isComb = link.filter.type === "comb" || link.filter.type === "comb-notch";
      link.filter.resonance = this.clamp(
        Number.isFinite(Number(value)) ? Number(value) : isComb ? 0.45 : 0.7,
        isComb ? -0.98 : 0.1,
        link.filter.type === "formant" ? FORMANT_INTENSITY_MAX : isComb ? 0.98 : 12,
      );
      if (link.filter.type === "formant" && this.wasm?.setLinkFilterResonance && link.wasmIndex >= 0) {
        this.wasm.setLinkFilterResonance(link.wasmIndex, link.filter.resonance);
      }
    } else if (parameter === "distortion.gain") {
      link.distortion = {
        ...(link.distortion || { enabled: false, type: "soft-clip", gain: 1.5 }),
        gain: this.clamp(Number(value) || 1.5, 0.1, 40),
      };
    } else {
      return;
    }

    link.controlSmoother = this.syncLinkControlSmoother(link);
  }

  linkControlTargets(link) {
    return {
      amount: link.amount,
      delay: link.delay,
      noise: link.noise,
      pan: link.pan,
      filterCutoff: link.filter?.cutoff ?? 5000,
      filterResonance: link.filter?.resonance || 0.7,
      distortionGain: link.distortion?.gain ?? 1.5,
    };
  }

  linkControlIsSettled(smoother) {
    const { current, target } = smoother;
    return current.amount === target.amount
      && current.delay === target.delay
      && current.noise === target.noise
      && current.pan === target.pan
      && current.filterCutoff === target.filterCutoff
      && current.filterResonance === target.filterResonance
      && current.distortionGain === target.distortionGain;
  }

  syncActiveLinkControlSmoother(smoother) {
    if (this.linkControlIsSettled(smoother)) {
      this.activeLinkControlSmoothers.delete(smoother.id);
    } else {
      this.activeLinkControlSmoothers.add(smoother.id);
    }
  }

  syncLinkControlSmoother(link, resetCurrent = false) {
    const target = this.linkControlTargets(link);
    const existing = this.linkControlSmoothers.get(link.id);
    if (existing) {
      existing.target = target;
      if (resetCurrent) existing.current = { ...target };
      if (resetCurrent || link.filter?.type === "formant") {
        existing.current.filterCutoff = target.filterCutoff;
        existing.current.filterResonance = target.filterResonance;
      }
      this.syncActiveLinkControlSmoother(existing);
      return existing;
    }

    const smoother = {
      id: link.id,
      current: { ...target },
      target,
    };
    this.linkControlSmoothers.set(link.id, smoother);
    this.syncActiveLinkControlSmoother(smoother);
    return smoother;
  }

  smoothControlValue(current, target, alpha) {
    const next = current + (target - current) * alpha;
    return Math.abs(target - next) <= LINK_CONTROL_SETTLE_EPSILON ? target : next;
  }

  applyLinkControlSmoother(link) {
    const current = link.controlSmoother?.current || this.linkControlTargets(link);
    if (this.wasm?.setLinkAmount && link.wasmIndex >= 0) {
      this.wasm.setLinkAmount(link.wasmIndex, current.amount);
    }
    if (this.wasm?.setLinkDelay && link.wasmIndex >= 0) {
      this.wasm.setLinkDelay(link.wasmIndex, current.delay);
    }
    if (this.wasm?.setLinkNoise && link.wasmIndex >= 0) {
      this.wasm.setLinkNoise(link.wasmIndex, current.noise);
    }
    if (this.wasm?.setLinkPan && link.wasmIndex >= 0) {
      this.wasm.setLinkPan(link.wasmIndex, current.pan);
    }
    if (this.wasm?.setLinkFilterCutoff && link.wasmIndex >= 0) {
      this.wasm.setLinkFilterCutoff(link.wasmIndex, current.filterCutoff);
    }
    if (this.wasm?.setLinkFilterResonance && link.wasmIndex >= 0) {
      this.wasm.setLinkFilterResonance(link.wasmIndex, current.filterResonance);
    }
    if (this.wasm?.setLinkDistortionGain && link.wasmIndex >= 0) {
      this.wasm.setLinkDistortionGain(link.wasmIndex, current.distortionGain);
    }
  }

  advanceLinkControlSmoothers(frames = this.lastProcessFrames || 128) {
    if (!this.activeLinkControlSmoothers.size) return;
    const alpha = 1 - Math.exp(-Math.max(1, frames) / (sampleRate * LINK_CONTROL_SMOOTH_SECONDS));

    for (const id of [...this.activeLinkControlSmoothers]) {
      const smoother = this.linkControlSmoothers.get(id);
      const link = this.linksById.get(id);
      if (!smoother || !link) {
        this.activeLinkControlSmoothers.delete(id);
        continue;
      }

      const { current, target } = smoother;
      current.amount = this.smoothControlValue(current.amount, target.amount, alpha);
      current.delay = this.smoothControlValue(current.delay, target.delay, alpha);
      current.noise = this.smoothControlValue(current.noise, target.noise, alpha);
      current.pan = this.smoothControlValue(current.pan, target.pan, alpha);
      current.filterCutoff = this.smoothControlValue(current.filterCutoff, target.filterCutoff, alpha);
      current.filterResonance = this.smoothControlValue(current.filterResonance, target.filterResonance, alpha);
      current.distortionGain = this.smoothControlValue(current.distortionGain, target.distortionGain, alpha);
      this.applyLinkControlSmoother(link);
      this.syncActiveLinkControlSmoother(smoother);
    }
  }

  normalizeEffects(effects = {}) {
    return {
      chorus: {
        enabled: Boolean(effects.chorus?.enabled),
        rate: this.clamp(Number(effects.chorus?.rate) || 0.8, 0.05, 6),
        depth: this.clamp(Number(effects.chorus?.depth) || 0.012, 0.001, 0.04),
        mix: this.clamp(Number(effects.chorus?.mix) || 0.25, 0, 1),
      },
      delay: {
        enabled: Boolean(effects.delay?.enabled),
        time: this.clamp(Number(effects.delay?.time) || 0.28, 0.02, 1.5),
        feedback: this.clamp(Number(effects.delay?.feedback) || 0.35, 0, 0.92),
        mix: this.clamp(Number(effects.delay?.mix) || 0.25, 0, 1),
      },
      reverb: {
        enabled: Boolean(effects.reverb?.enabled),
        size: this.clamp(Number(effects.reverb?.size) || 0.55, 0.1, 1),
        decay: this.clamp(Number(effects.reverb?.decay) || 0.45, 0, 0.94),
        mix: this.clamp(Number(effects.reverb?.mix) || 0.25, 0, 1),
      },
    };
  }

  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  sanitizeSample(value, limit = 16) {
    if (!Number.isFinite(value)) return 0;
    if (Math.abs(value) < DENORMAL_EPSILON) return 0;
    return this.clamp(value, -limit, limit);
  }

  smoothStep(t) {
    const x = this.clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  createReverbDelays() {
    return [0.043, 0.061, 0.079, 0.097].map((time) => ({
      buffer: new Float32Array(Math.ceil(sampleRate * time)),
      index: 0,
    }));
  }

  createDcBlocker() {
    return {
      input: 0,
      output: 0,
      coefficient: Math.exp((-TWO_PI * MASTER_DC_BLOCK_HZ) / sampleRate),
    };
  }

  readDelay(buffer, writeIndex, delaySamples) {
    const length = buffer.length;
    let index = writeIndex - delaySamples;
    if (index < 0) index += length;

    const indexA = Math.floor(index) % length;
    const indexB = (indexA + 1) % length;
    const fraction = index - Math.floor(index);
    return this.sanitizeSample(buffer[indexA] * (1 - fraction) + buffer[indexB] * fraction);
  }

  applyChorus(sample, channel) {
    const cleanSample = this.sanitizeSample(sample);
    const effect = this.masterEffects.chorus;
    const buffer = this.chorusBuffers[channel];
    const index = this.chorusIndices[channel];
    if (!effect.enabled || effect.mix <= 0) {
      buffer[index] = cleanSample;
      this.chorusIndices[channel] = (index + 1) % buffer.length;
      return cleanSample;
    }

    const baseDelay = 0.012 * sampleRate;
    const depthSamples = effect.depth * sampleRate;
    const lfo = 0.5 + 0.5 * Math.sin(this.chorusPhases[channel]);
    const delayed = this.readDelay(buffer, index, baseDelay + depthSamples * lfo);
    buffer[index] = cleanSample;
    this.chorusIndices[channel] = (index + 1) % buffer.length;
    this.chorusPhases[channel] = (this.chorusPhases[channel] + (TWO_PI * effect.rate) / sampleRate) % TWO_PI;
    return this.sanitizeSample(cleanSample * (1 - effect.mix) + delayed * effect.mix);
  }

  applyDelay(sample, channel) {
    const cleanSample = this.sanitizeSample(sample);
    const effect = this.masterEffects.delay;
    const buffer = this.delayBuffers[channel];
    const index = this.delayIndices[channel];
    const active = effect.enabled && effect.mix > 0;
    const delaySamples = Math.min(buffer.length - 1, Math.max(1, effect.time * sampleRate));
    const delayed = this.readDelay(buffer, index, delaySamples);
    buffer[index] = this.sanitizeSample(cleanSample + delayed * (active ? effect.feedback : 0));
    this.delayIndices[channel] = (index + 1) % buffer.length;

    if (!active) return cleanSample;
    return this.sanitizeSample(cleanSample * (1 - effect.mix) + delayed * effect.mix);
  }

  applyReverb(sample, channel) {
    const cleanSample = this.sanitizeSample(sample);
    const effect = this.masterEffects.reverb;
    const active = effect.enabled && effect.mix > 0;
    let wet = 0;

    for (const delay of this.reverbDelays[channel]) {
      const readIndex = delay.index;
      const delayed = this.sanitizeSample(delay.buffer[readIndex]);
      wet += delayed;
      const damping = active ? effect.decay * (0.55 + effect.size * 0.4) : 0;
      delay.buffer[readIndex] = this.sanitizeSample(cleanSample + delayed * damping);
      delay.index = (delay.index + 1) % delay.buffer.length;
    }

    wet *= 0.25;
    if (!active) return cleanSample;
    return this.sanitizeSample(cleanSample * (1 - effect.mix) + wet * effect.mix);
  }

  applyDcBlocker(sample, channel, blockers) {
    const state = blockers[channel];
    const cleanSample = this.sanitizeSample(sample, 4);
    const output = cleanSample - state.input + state.coefficient * state.output;
    state.input = cleanSample;
    state.output = this.sanitizeSample(output, 4);
    return state.output;
  }

  applyMasterEffects(sample, channel) {
    let effected = this.applyDcBlocker(sample, channel, this.inputDcBlockers);
    effected = this.applyChorus(effected, channel);
    effected = this.applyDelay(effected, channel);
    effected = this.applyReverb(effected, channel);
    return this.sanitizeSample(Math.tanh(this.applyDcBlocker(effected, channel, this.outputDcBlockers)), 1);
  }

  midiNoteFrequency(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  allocateSlot() {
    if (this.freeSlots.length) return this.freeSlots.shift();
    const stolenVoice = [...this.voices.values()]
      .filter((voice) => voice.stolenAt !== null)
      .sort((a, b) => a.stolenAt - b.stolenAt)[0];
    if (stolenVoice) {
      const slot = stolenVoice.slot;
      this.deleteVoice(stolenVoice.id, { keepSlot: true });
      return slot;
    }
    return null;
  }

  voiceToSteal() {
    const voices = [...this.voices.values()];
    return voices
      .filter((voice) => voice.stolenAt === null)
      .sort((a, b) => {
        if ((a.releasedAt === null) !== (b.releasedAt === null)) return a.releasedAt === null ? 1 : -1;
        return (a.releasedAt ?? a.startedAt) - (b.releasedAt ?? b.startedAt);
      })[0] || null;
  }

  activeVoiceToSteal() {
    return [...this.voices.values()]
      .filter((voice) => voice.stolenAt === null && voice.releasedAt === null)
      .sort((a, b) => a.startedAt - b.startedAt)[0] || null;
  }

  activeVoiceCount() {
    let count = 0;
    for (const voice of this.voices.values()) {
      if (voice.stolenAt === null) count += 1;
    }
    return count;
  }

  stealVoiceForFade() {
    const candidate = this.voiceToSteal();
    if (!candidate) return false;
    candidate.stolenAt = this.sampleCursor / sampleRate;
    this.forgetActiveVoice(candidate.id);
    return true;
  }

  enforceVoiceLimit(limit = this.maxVoices) {
    while (this.activeVoiceCount() > limit) {
      const candidate = this.activeVoiceToSteal() || this.voiceToSteal();
      if (!candidate) return;
      candidate.stolenAt = this.sampleCursor / sampleRate;
      this.forgetActiveVoice(candidate.id);
    }
  }

  forgetActiveVoice(voiceId) {
    for (const [note, activeVoiceId] of this.activeVoicesByNote) {
      if (activeVoiceId === voiceId) this.activeVoicesByNote.delete(note);
    }
  }

  latestStolenFadeEnd(now = this.sampleCursor / sampleRate) {
    let fadeEnd = now;
    for (const voice of this.voices.values()) {
      if (voice.stolenAt !== null) {
        fadeEnd = Math.max(fadeEnd, voice.stolenAt + VOICE_STEAL_FADE_SECONDS);
      }
    }
    return fadeEnd;
  }

  queueVoiceStart(note, velocity, readyAt) {
    this.pendingVoiceStarts = this.pendingVoiceStarts.filter((pending) => pending.note !== note);
    this.pendingVoiceStarts.push({ note, velocity, readyAt });
  }

  flushPendingVoiceStarts(now) {
    if (!this.pendingVoiceStarts.length) return;

    let ready = [];
    const remaining = [];
    for (const pending of this.pendingVoiceStarts) {
      if (pending.readyAt > now) {
        remaining.push(pending);
      } else {
        ready.push(pending);
      }
    }
    if (!ready.length) {
      this.pendingVoiceStarts = remaining;
      return;
    }

    if (ready.length > this.maxVoices) {
      ready = ready.slice(ready.length - this.maxVoices);
    }

    const freeActiveSlots = Math.max(0, this.maxVoices - this.activeVoiceCount());
    const slotsToReserve = Math.max(0, ready.length - freeActiveSlots);
    if (slotsToReserve > 0) {
      let reservedSlots = 0;
      while (reservedSlots < slotsToReserve && this.stealVoiceForFade()) {
        reservedSlots += 1;
      }
      this.pendingVoiceStarts = [
        ...remaining,
        ...ready.map((pending) => ({ ...pending, readyAt: this.latestStolenFadeEnd(now) })),
      ];
      return;
    }

    const stillPending = [];
    for (const pending of ready) {
      if (this.startVoice(pending.note, pending.velocity, now)) continue;
      stillPending.push({ ...pending, readyAt: this.latestStolenFadeEnd(now) });
    }
    this.pendingVoiceStarts = [...remaining, ...stillPending];
    this.enforceVoiceLimit();
  }

  startVoice(note, velocity = 1, startedAt = this.sampleCursor / sampleRate) {
    const numericNote = Number(note);
    if (!Number.isFinite(numericNote)) return false;
    const slot = this.allocateSlot();
    if (slot === null) return false;
    this.wasm?.resetVoiceSlot?.(slot);
    if (this.zeroVoicePhasesOnStart) this.wasm?.resetVoiceSlotPhases?.(slot);
    const voice = {
      id: `voice-${this.voiceCounter++}`,
      slot,
      note: numericNote,
      frequency: this.midiNoteFrequency(numericNote),
      velocity: this.clamp(Number(velocity) || 0, 0.05, 1),
      startedAt,
      releasedAt: null,
      stolenAt: null,
      releaseSeconds: 0.24,
      releaseGain: 1,
      oneShotSampleEndAt: this.oneShotSampleEndAt(startedAt, this.midiNoteFrequency(numericNote)),
    };
    this.voices.set(voice.id, voice);
    this.activeVoicesByNote.set(numericNote, voice.id);
    return true;
  }

  noteOn(note, velocity = 1) {
    const numericNote = Number(note);
    if (!Number.isFinite(numericNote)) return;
    const now = this.sampleCursor / sampleRate;
    const activeVoice = this.voices.get(this.activeVoicesByNote.get(numericNote));
    if (activeVoice && activeVoice.releasedAt === null) {
      activeVoice.releasedAt = now;
      this.activeVoicesByNote.delete(numericNote);
    }
    this.queueVoiceStart(numericNote, velocity, now);
    this.flushPendingVoiceStarts(now);
  }

  noteOff(note) {
    const numericNote = Number(note);
    this.pendingVoiceStarts = this.pendingVoiceStarts.filter((pending) => pending.note !== numericNote);
    const voice = this.voices.get(this.activeVoicesByNote.get(numericNote));
    if (!voice) return;
    if (voice.oneShotSampleEndAt !== null && this.sampleCursor / sampleRate < voice.oneShotSampleEndAt) {
      return;
    }
    this.releaseVoice(voice, this.sampleCursor / sampleRate, this.outputReleaseSeconds());
  }

  releaseVoice(voice, now, releaseSeconds) {
    if (voice.releasedAt !== null) return;
    voice.releaseGain = this.voiceLifecycleGain(voice, now);
    voice.releaseSeconds = releaseSeconds;
    voice.releasedAt = now;
    this.activeVoicesByNote.delete(voice.note);
  }

  deleteVoice(voiceId, { keepSlot = false } = {}) {
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    this.voices.delete(voiceId);
    for (const [note, activeVoiceId] of this.activeVoicesByNote) {
      if (activeVoiceId === voiceId) this.activeVoicesByNote.delete(note);
    }
    if (!keepSlot && Number.isInteger(voice.slot)) {
      this.freeSlots.push(voice.slot);
      this.freeSlots.sort((a, b) => a - b);
    }
  }

  outputReleaseSeconds() {
    const outputReleases = this.links
      .filter((link) => link.to === "audio")
      .map((link) => link.envelope?.release || 0.24);
    return Math.max(0.001, ...outputReleases);
  }

  sampleRangeLength(node) {
    const entry = this.sampleDataByNodeId.get(node.id);
    const length = entry?.data?.length || 0;
    if (!length) return 0;
    const start = this.clamp(Number(node.sample?.start) || 0, 0, 1);
    const end = this.clamp(Number.isFinite(Number(node.sample?.end)) ? Number(node.sample.end) : 1, 0, 1);
    const maxFrame = Math.max(0, length - 1);
    return Math.abs(Math.round(end * maxFrame) - Math.round(start * maxFrame)) + 1;
  }

  oneShotSampleDuration(node, noteFrequency) {
    if (node.wave !== "sample" || node.sample?.mode !== "one-shot") return 0;
    const rangeLength = this.sampleRangeLength(node);
    if (!rangeLength) return 0;
    const entry = this.sampleDataByNodeId.get(node.id);
    const original = this.midiNoteFrequency(node.sample?.originalPitch ?? 60);
    const base = node.frequencyMode === "fixed"
      ? Number(node.frequency) || 0
      : noteFrequency * (Number.isFinite(Number(node.ratio)) ? Number(node.ratio) : 1);
    const playbackRate = Math.max(0.0001, base) / Math.max(0.0001, original);
    const sourceRate = Math.max(1, entry?.sampleRate || sampleRate);
    return rangeLength / sourceRate / playbackRate;
  }

  oneShotSampleEndAt(startedAt, noteFrequency) {
    let duration = 0;
    for (const node of this.nodes) {
      duration = Math.max(duration, this.oneShotSampleDuration(node, noteFrequency));
    }
    return duration > 0 ? startedAt + duration : null;
  }

  voiceLifecycleGain(voice, now) {
    const startGain = this.smoothStep((now - voice.startedAt) / VOICE_START_FADE_SECONDS);
    if (voice.stolenAt === null) return startGain;
    const stealFade = 1 - this.smoothStep((now - voice.stolenAt) / VOICE_STEAL_FADE_SECONDS);
    return startGain * stealFade;
  }

  pruneVoices(now) {
    for (const voice of [...this.voices.values()]) {
      if (voice.releasedAt === null && voice.oneShotSampleEndAt !== null && now >= voice.oneShotSampleEndAt) {
        this.deleteVoice(voice.id);
        continue;
      }
      const stealFinished = voice.stolenAt !== null && now - voice.stolenAt > VOICE_STEAL_FADE_SECONDS;
      const releaseFinished = voice.releasedAt !== null && now - voice.releasedAt > (voice.releaseSeconds || 0.24) + 0.02;
      if (stealFinished || releaseFinished) {
        this.deleteVoice(voice.id);
      }
    }
    this.enforceVoiceLimit();
    this.flushPendingVoiceStarts(now);
  }

  resetRuntimeState() {
    this.voices.clear();
    this.activeVoicesByNote.clear();
    this.pendingVoiceStarts = [];
    this.freeSlots = Array.from({ length: MAX_ACTIVE_VOICES }, (_, index) => index);
    this.chorusBuffers.forEach((buffer) => buffer.fill(0));
    this.chorusIndices = [0, 0];
    this.chorusPhases = [0, Math.PI * 0.5];
    this.delayBuffers.forEach((buffer) => buffer.fill(0));
    this.delayIndices = [0, 0];
    this.reverbDelays = [this.createReverbDelays(), this.createReverbDelays()];
    this.inputDcBlockers = [this.createDcBlocker(), this.createDcBlocker()];
    this.outputDcBlockers = [this.createDcBlocker(), this.createDcBlocker()];
    if (this.wasm) this.wasm.resetPhases();
    this.wasm?.clearLinkMeters?.();
  }

  setMuted(muted) {
    this.muted = muted;
    this.zeroVoicePhasesOnStart = !muted;
    this.resetRuntimeState();
  }

  waveId(node) {
    return WAVE_IDS.get(node?.wave) || 0;
  }

  frequencyModeId(node) {
    return node?.frequencyMode === "fixed" ? 1 : 0;
  }

  renderVoice(voice, now, frames) {
    this.wasm.renderVoiceGraph(
      voice.slot,
      frames,
      sampleRate,
      voice.frequency,
      voice.velocity,
      1,
      now - voice.startedAt,
      voice.releasedAt === null ? -1 : now - voice.releasedAt,
      voice.stolenAt === null ? -1 : now - voice.stolenAt,
    );
  }

  flushLinkMeters() {
    if (this.sampleCursor < this.nextLinkMeterPostSample) return;
    this.nextLinkMeterPostSample = this.sampleCursor + Math.max(1, Math.round(sampleRate * LINK_METER_POST_SECONDS));
    const levels = this.links.map((link) => {
      const index = link.wasmIndex;
      const count = index >= 0 ? this.linkMeterCounts?.[index] || 0 : 0;
      if (count > 0) {
        return [
          link.id,
          this.clamp((this.linkMeterInputSums?.[index] || 0) / count, 0, 1),
          this.clamp((this.linkMeterOutputSums?.[index] || 0) / count, 0, 1),
          this.clamp((this.linkMeterEnvelopeSums?.[index] || 0) / count, 0, 1),
        ];
      }
      return [link.id, 0, 0, 0];
    });
    this.lastOutputPeak = 0;
    this.wasm?.clearLinkMeters?.();
    this.port.postMessage({ type: "linkMeters", payload: { levels } });
  }

  fillSilence(outputs) {
    const output = outputs[0];
    const left = output?.[0];
    const right = output?.[1] || left;
    if (!left) return;
    left.fill(0);
    if (right !== left) right.fill(0);
  }

  copyInput(inputs, frames) {
    if (!this.inputBuffer) return;
    const input = inputs[0];
    const inputLeft = input?.[0];
    const inputRight = input?.[1] || inputLeft;
    for (let i = 0; i < frames; i += 1) {
      this.inputBuffer[i] = inputLeft
        ? ((inputLeft[i] || 0) + (inputRight?.[i] || 0)) * 0.5
        : 0;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const left = output?.[0];
    const right = output?.[1] || left;
    if (!left) return true;

    const frames = Math.min(left.length, MAX_WASM_FRAMES);
    this.lastProcessFrames = frames;
    const now = this.sampleCursor / sampleRate;

    if (this.muted) {
      this.fillSilence(outputs);
      return true;
    }

    if (!this.ready || !this.links.some((link) => link.to === "audio" && link.wasmIndex >= 0)) {
      this.fillSilence(outputs);
      this.sampleCursor += left.length;
      return true;
    }

    this.pruneVoices(now);
    this.advanceLinkControlSmoothers(frames);
    this.wasm.clear(frames);
    this.copyInput(inputs, frames);

    if (this.hasActiveDroneLinks) {
      this.renderVoice({
        slot: DRONE_SLOT,
        frequency: 440,
        velocity: 1,
        startedAt: 0,
        releasedAt: null,
        stolenAt: null,
      }, now, frames);
    }

    for (const voice of this.voices.values()) {
      this.renderVoice(voice, now, frames);
    }

    let peak = 0;
    for (let i = 0; i < frames; i += 1) {
      const leftSample = this.applyMasterEffects(Math.tanh((this.leftBuffer[i] || 0) * MASTER_GAIN), 0);
      const rightSample = this.applyMasterEffects(Math.tanh((this.rightBuffer[i] || 0) * MASTER_GAIN), 1);
      left[i] = leftSample;
      right[i] = rightSample;
      peak = Math.max(peak, Math.abs(leftSample), Math.abs(rightSample));
    }
    for (let i = frames; i < left.length; i += 1) {
      left[i] = 0;
      right[i] = 0;
    }
    this.lastOutputPeak = Math.max(this.lastOutputPeak, peak);
    this.sampleCursor += left.length;
    this.flushLinkMeters();
    return true;
  }
}

registerProcessor("visual-fm-wasm-engine", VisualFmWasmEngine);
