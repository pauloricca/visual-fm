const TWO_PI = Math.PI * 2;
const MAX_LINK_DELAY_SECONDS = 3;
const VELOCITY_SENSITIVITY_MIN = -8;
const VELOCITY_SENSITIVITY_MAX = 8;
const DEFAULT_MAX_ACTIVE_VOICES = 5;
const MIN_MAX_ACTIVE_VOICES = 1;
const MAX_MAX_ACTIVE_VOICES = 16;
const NOTE_ON_BATCH_SECONDS = 0.008;
const VOICE_START_FADE_SECONDS = 0.006;
const VOICE_STEAL_FADE_SECONDS = 0.03;
const CUSTOM_ONESHOT_EDGE_FADE_SECONDS = 0.002;
const LINK_CONTROL_SMOOTH_SECONDS = 0.012;
const LINK_CONTROL_SETTLE_EPSILON = 1e-7;
const ENVELOPE_TRIGGER_THRESHOLD = 0.5;
const ENVELOPE_TRIGGER_REARM = 0.45;
const LINK_METER_POST_SECONDS = 1 / 30;
const DENORMAL_EPSILON = 1e-20;
const MASTER_DC_BLOCK_HZ = 10;
const FORMANT_INTENSITY_MAX = 36;
const EMPTY_LINKS = Object.freeze([]);
const OSCILLATOR_WAVE_TYPES = ["sine", "triangle", "saw", "ramp", "square", "sample-hold", "custom"];
const WAVE_TYPES = new Set(["sine", "triangle", "saw", "ramp", "square", "sample-hold", "custom", "noise", "perlin", "audio-input"]);
const PITCHED_WAVE_TYPES = new Set(["sine", "triangle", "saw", "ramp", "square", "sample-hold", "custom"]);
const SPEED_WAVE_TYPES = new Set(["perlin"]);
const QUANTISE_ROOT_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const QUANTISE_SCALE_INTERVALS = Object.freeze({
  chromatic: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  major: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
  minor: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
  "major-pentatonic": Object.freeze([0, 2, 4, 7, 9]),
  "minor-pentatonic": Object.freeze([0, 3, 5, 7, 10]),
  blues: Object.freeze([0, 3, 5, 6, 7, 10]),
  dorian: Object.freeze([0, 2, 3, 5, 7, 9, 10]),
  mixolydian: Object.freeze([0, 2, 4, 5, 7, 9, 10]),
  "harmonic-minor": Object.freeze([0, 2, 3, 5, 7, 8, 11]),
});
const LINK_SIGNAL_MODES = new Set(["raw", "envelope", "inverted-envelope"]);
const LINK_DISTORTION_TYPES = new Set(["hard-clip", "soft-clip", "fuzz", "saturate", "wavefold"]);
const LINK_ENVELOPE_TARGETS = new Set([
  "envelope.delay",
  "envelope.attack",
  "envelope.decay",
  "envelope.sustain",
  "envelope.release",
]);
const DEFAULT_ENVELOPE = Object.freeze({
  delay: 0,
  attack: 0.01,
  decay: 0.16,
  sustain: 0.72,
  release: 0.24,
});
const DEFAULT_LINK_FOLLOWER = Object.freeze({
  attack: 0.01,
  release: 0.12,
});
const DEFAULT_CUSTOM_WAVE = Object.freeze({
  mode: "loop",
  sustainStart: 0.5,
  sustainEnd: 0.75,
  points: Object.freeze([
    Object.freeze({ x: 0, y: 0 }),
    Object.freeze({ x: 1, y: 0 }),
  ]),
});
const FORMANT_VOWELS = Object.freeze([
  Object.freeze([
    Object.freeze({ frequency: 800, q: 7.5, gainDb: 0 }),
    Object.freeze({ frequency: 1150, q: 9, gainDb: -5 }),
    Object.freeze({ frequency: 2900, q: 12, gainDb: -13 }),
  ]),
  Object.freeze([
    Object.freeze({ frequency: 420, q: 7.5, gainDb: 0 }),
    Object.freeze({ frequency: 1750, q: 12, gainDb: -4 }),
    Object.freeze({ frequency: 2600, q: 13, gainDb: -12 }),
  ]),
  Object.freeze([
    Object.freeze({ frequency: 300, q: 8.5, gainDb: 0 }),
    Object.freeze({ frequency: 2200, q: 14, gainDb: -3 }),
    Object.freeze({ frequency: 3000, q: 15, gainDb: -10 }),
  ]),
  Object.freeze([
    Object.freeze({ frequency: 500, q: 8, gainDb: 0 }),
    Object.freeze({ frequency: 900, q: 9, gainDb: -5 }),
    Object.freeze({ frequency: 2500, q: 12, gainDb: -14 }),
  ]),
  Object.freeze([
    Object.freeze({ frequency: 350, q: 8, gainDb: 0 }),
    Object.freeze({ frequency: 700, q: 9, gainDb: -7 }),
    Object.freeze({ frequency: 2400, q: 12, gainDb: -16 }),
  ]),
]);

class VisualFmEngine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.nodes = [];
    this.nodesById = new Map();
    this.links = [];
    this.incoming = new Map();
    this.outputLinks = [];
    this.linksById = new Map();
    this.linkModulations = new Map();
    this.linkControlSmoothers = new Map();
    this.activeLinkControlSmoothers = new Set();
    this.voices = new Map();
    this.activeVoicesByNote = new Map();
    this.pendingVoiceStarts = [];
    this.maxVoices = DEFAULT_MAX_ACTIVE_VOICES;
    this.voiceCounter = 1;
    this.droneVoice = this.createVoice("drone", 440, 1, 0, true);
    this.hasActiveDroneLinks = false;
    this.sampleCursor = 0;
    this.nextLinkMeterPostSample = 0;
    this.linkMeterPeaks = new Map();
    this.currentInputSample = 0;
    this.masterGain = 0.18;
    this.linkControlSmoothAlpha = 1 - Math.exp(-1 / (sampleRate * LINK_CONTROL_SMOOTH_SECONDS));
    this.masterEffects = {
      chorus: { enabled: false, rate: 0.8, depth: 0.012, mix: 0.25 },
      delay: { enabled: false, time: 0.28, feedback: 0.35, mix: 0.25 },
      reverb: { enabled: false, size: 0.55, decay: 0.45, mix: 0.25 },
    };
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
      const { type, payload } = event.data;
      if (type === "graph") {
        this.setGraph(payload);
      }
      if (type === "linkParam") {
        this.setLinkParam(payload);
      }
      if (type === "noteOn") {
        this.noteOn(payload.note, payload.velocity);
      }
      if (type === "noteOff") {
        this.noteOff(payload.note);
      }
      if (type === "panic") {
        this.resetRuntimeState();
      }
    };
  }

  setGraph(graph) {
    this.nodes = (graph.nodes || []).map((node) => this.normalizeNode(node));
    this.nodesById = new Map(this.nodes.map((node) => [node.id, node]));
    this.maxVoices = this.normalizeMaxVoices(graph.maxVoices);
    const rawLinks = graph.links || [];
    const rawLinksById = new Map(rawLinks.map((link) => [link.id, link]));
    this.links = rawLinks.map((link) => {
      const targetLink = rawLinksById.get(link.to);
      const targetNode = this.nodesById.get(link.to);
      const filter = this.normalizeLinkFilter(link.filter);
      const distortion = this.normalizeLinkDistortion(link.distortion);
      const normalized = {
        ...link,
        modulationTarget: this.normalizeModulationTarget(link.modulationTarget, link.to, targetLink, targetNode),
        drone: Boolean(link.drone),
        signalMode: LINK_SIGNAL_MODES.has(link.signalMode) ? link.signalMode : "raw",
        follower: this.normalizeFollower(link.follower),
        amount: this.clamp(Number(link.amount) || 0, 0, 32),
        delay: this.clamp(Number(link.delay) || 0, 0, MAX_LINK_DELAY_SECONDS),
        noise: this.clamp(Number(link.noise) || 0, 0, 1),
        pan: this.clamp(Number(link.pan) || 0, -1, 1),
        velocitySensitivity: this.clamp(
          Number(link.velocitySensitivity) || 0,
          VELOCITY_SENSITIVITY_MIN,
          VELOCITY_SENSITIVITY_MAX,
        ),
        filter,
        distortion,
      };
      normalized.filter = filter;
      normalized.filterStateKey = `${normalized.id}:${filter.type}`;
      normalized.controlSmoother = this.syncLinkControlSmoother(normalized);
      normalized.baseParams = this.createBaseLinkParams(normalized);
      normalized.modulators = EMPTY_LINKS;
      normalized.hasModulators = false;
      return normalized;
    });
    const linkIds = new Set(this.links.map((link) => link.id));
    for (const id of this.linkControlSmoothers.keys()) {
      if (!linkIds.has(id)) {
        this.linkControlSmoothers.delete(id);
        this.activeLinkControlSmoothers.delete(id);
      }
    }
    this.hasActiveDroneLinks = this.links.some((link) => link.drone);
    this.masterEffects = this.normalizeEffects(graph.masterEffects);
    this.incoming = new Map();
    this.outputLinks = [];
    this.linksById = new Map(this.links.map((link) => [link.id, link]));
    this.linkModulations = new Map();

    for (const link of this.links) {
      if (link.to === "audio") {
        this.outputLinks.push(link);
      } else if (this.linksById.has(link.to)) {
        const group = this.linkModulations.get(link.to) || [];
        group.push(link);
        this.linkModulations.set(link.to, group);
      } else {
        const group = this.incoming.get(link.to) || [];
        group.push(link);
        this.incoming.set(link.to, group);
      }
    }

    for (const link of this.links) {
      const modulators = this.linkModulations.get(link.id);
      link.modulators = modulators || EMPTY_LINKS;
      link.hasModulators = Boolean(modulators?.length);
      link.hasEnvelopeTriggers = link.modulators.some((modLink) => modLink.modulationTarget === "envelopeTrigger");
      link.hasDelayModulators = link.modulators.some((modLink) => modLink.modulationTarget === "delay");
    }
    this.hasActiveDroneLinks = this.links.some((link) => link.drone || link.hasEnvelopeTriggers);

    const linkStateKeys = new Set(this.links.map((link) => link.filterStateKey || link.id));
    for (const voice of [...this.voices.values(), this.droneVoice]) {
      this.syncVoiceGraphState(voice, linkStateKeys);
    }
  }

  syncVoiceGraphState(voice, linkStateKeys) {
    if (!voice.nodeFilters) voice.nodeFilters = new Map();
    if (!voice.frequencyMods) voice.frequencyMods = new Map();
    if (!voice.quantisedFrequencyStates) voice.quantisedFrequencyStates = new Map();
    if (!voice.linkDelays) voice.linkDelays = new Map();
    if (!voice.renderCache) voice.renderCache = new Map();
    if (!voice.renderStack) voice.renderStack = new Set();
    if (!voice.linkStack) voice.linkStack = new Set();
    if (!voice.linkParamCache) voice.linkParamCache = new Map();
    if (!voice.linkTriggerSigns) voice.linkTriggerSigns = new Map();
    if (!voice.linkTriggerArmed) voice.linkTriggerArmed = new Map();
    if (!voice.linkFollowers) voice.linkFollowers = new Map();
    if (!voice.linkEnvelopeStarts) voice.linkEnvelopeStarts = new Map();
    if (!voice.linkEnvelopeStartLevels) voice.linkEnvelopeStartLevels = new Map();
    if (!voice.linkEnvelopeReleaseStarts) voice.linkEnvelopeReleaseStarts = new Map();
    if (!voice.linkEnvelopeReleaseLevels) voice.linkEnvelopeReleaseLevels = new Map();
    if (!voice.sampleHolds) voice.sampleHolds = new Map();
    if (!voice.perlinStates) voice.perlinStates = new Map();
    if (!voice.customWaveDone) voice.customWaveDone = new Map();
    if (!voice.customWaveDirections) voice.customWaveDirections = new Map();

    const nodeIds = new Set(this.nodes.map((node) => node.id));
    const linkIds = new Set(this.links.map((link) => link.id));

    for (const key of voice.phases.keys()) {
      if (!nodeIds.has(key)) voice.phases.delete(key);
    }
    for (const key of voice.feedback.keys()) {
      if (!nodeIds.has(key)) voice.feedback.delete(key);
    }
    for (const key of voice.nodeFilters.keys()) {
      const nodeId = String(key).split(":")[0];
      if (!nodeIds.has(nodeId)) voice.nodeFilters.delete(key);
    }
    for (const key of voice.frequencyMods.keys()) {
      if (!nodeIds.has(key)) voice.frequencyMods.delete(key);
    }
    for (const key of voice.quantisedFrequencyStates.keys()) {
      if (!nodeIds.has(key)) voice.quantisedFrequencyStates.delete(key);
    }
    for (const key of voice.sampleHolds.keys()) {
      if (!nodeIds.has(key)) voice.sampleHolds.delete(key);
    }
    for (const key of voice.perlinStates.keys()) {
      if (!nodeIds.has(key)) voice.perlinStates.delete(key);
    }
    for (const key of voice.customWaveDone.keys()) {
      if (!nodeIds.has(key)) voice.customWaveDone.delete(key);
    }
    for (const key of voice.customWaveDirections.keys()) {
      if (!nodeIds.has(key)) voice.customWaveDirections.delete(key);
    }
    for (const key of voice.linkFilters.keys()) {
      if (!linkStateKeys.has(key)) voice.linkFilters.delete(key);
    }
    for (const key of voice.linkDelays.keys()) {
      if (!linkIds.has(key)) voice.linkDelays.delete(key);
    }
    for (const key of voice.linkParamCache.keys()) {
      if (!linkIds.has(key)) voice.linkParamCache.delete(key);
    }
    for (const key of voice.linkTriggerSigns.keys()) {
      if (!linkIds.has(key)) voice.linkTriggerSigns.delete(key);
    }
    for (const key of voice.linkTriggerArmed.keys()) {
      if (!linkIds.has(key)) voice.linkTriggerArmed.delete(key);
    }
    for (const key of voice.linkFollowers.keys()) {
      if (!linkIds.has(key)) voice.linkFollowers.delete(key);
    }
    for (const key of voice.linkEnvelopeStarts.keys()) {
      if (!linkIds.has(key)) voice.linkEnvelopeStarts.delete(key);
    }
    for (const key of voice.linkEnvelopeStartLevels.keys()) {
      if (!linkIds.has(key)) voice.linkEnvelopeStartLevels.delete(key);
    }
    for (const key of voice.linkEnvelopeReleaseStarts.keys()) {
      if (!linkIds.has(key)) voice.linkEnvelopeReleaseStarts.delete(key);
    }
    for (const key of voice.linkEnvelopeReleaseLevels.keys()) {
      if (!linkIds.has(key)) voice.linkEnvelopeReleaseLevels.delete(key);
    }
    for (const key of voice.releaseLevels.keys()) {
      if (!linkIds.has(key)) voice.releaseLevels.delete(key);
    }

    for (const node of this.nodes) {
      if (!voice.phases.has(node.id)) {
        voice.phases.set(node.id, node.wave === "custom" ? 0 : Math.random());
      }
      if (!voice.feedback.has(node.id)) {
        voice.feedback.set(node.id, { prev1: 0, prev2: 0 });
      }
      if (node.wave === "sample-hold" && !voice.sampleHolds.has(node.id)) {
        voice.sampleHolds.set(node.id, this.randomBipolar());
      }
      if (node.wave === "perlin" && !voice.perlinStates.has(node.id)) {
        voice.perlinStates.set(node.id, this.createPerlinState());
      }
      if (node.wave !== "custom" || !this.isCustomOneShotMode(node.customWave?.mode)) {
        voice.customWaveDone.delete(node.id);
        voice.customWaveDirections.delete(node.id);
      }
    }
  }

  normalizeNode(node = {}) {
    const ratio = Number(node.ratio);
    const frequency = Number(node.frequency);
    const speed = Number(node.speed);
    const audioInputGain = Number(node.audioInputGain);
    const quantise = this.normalizeNodeQuantise(node.quantise);
    return {
      id: node.id,
      wave: WAVE_TYPES.has(node.wave) ? node.wave : "sine",
      frequencyMode: node.frequencyMode === "fixed" ? "fixed" : "ratio",
      ratio: Number.isFinite(ratio) ? this.clamp(ratio, 0, 16) : 1,
      frequency: Number.isFinite(frequency) ? this.clamp(frequency, 0, Math.min(12000, sampleRate * 0.45)) : 440,
      quantise,
      speed: Number.isFinite(speed) ? this.clamp(speed, 0.01, 60) : 8,
      audioInputGain: Number.isFinite(audioInputGain) ? this.clamp(audioInputGain, 0, 4) : 1,
      customWave: this.normalizeCustomWave(node.customWave),
    };
  }

  normalizeNodeQuantise(quantise = {}) {
    const glide = Number(quantise.glide);
    return {
      enabled: Boolean(quantise.enabled),
      root: QUANTISE_ROOT_NOTES.includes(quantise.root) ? quantise.root : "C",
      scale: QUANTISE_SCALE_INTERVALS[quantise.scale] ? quantise.scale : "chromatic",
      glide: Number.isFinite(glide) ? this.clamp(glide, 0, 4) : 0,
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
    return {
      mode,
      sustainStart,
      sustainEnd,
      points: [...pointsByX.entries()]
        .map(([x, y]) => ({ x, y }))
        .sort((a, b) => a.x - b.x),
    };
  }

  normalizeMaxVoices(maxVoices) {
    const value = Number(maxVoices);
    return Number.isFinite(value)
      ? this.clamp(Math.round(value), MIN_MAX_ACTIVE_VOICES, MAX_MAX_ACTIVE_VOICES)
      : DEFAULT_MAX_ACTIVE_VOICES;
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

  normalizeLinkFilter(filter = {}) {
    const type = ["none", "lowpass", "highpass", "bandpass", "comb", "comb-notch", "formant"].includes(filter.type) ? filter.type : "none";
    const isComb = type === "comb" || type === "comb-notch";
    const normalized = {
      type,
      cutoff: type === "formant"
        ? this.clamp(Number.isFinite(Number(filter.cutoff)) ? Number(filter.cutoff) : 0, 0, 1)
        : this.clamp(Number(filter.cutoff) || (isComb ? 440 : 5000), 20, Math.min(isComb ? 5000 : 12000, sampleRate * 0.45)),
      resonance: this.clamp(
        Number.isFinite(Number(filter.resonance)) ? Number(filter.resonance) : isComb ? 0.45 : 0.7,
        isComb ? -0.98 : 0.1,
        type === "formant" ? FORMANT_INTENSITY_MAX : isComb ? 0.98 : 12,
      ),
    };
    normalized.coefficients = type === "none" || type === "formant" || isComb ? null : this.filterCoefficients(normalized);
    return normalized;
  }

  normalizeLinkDistortion(distortion = {}) {
    return {
      enabled: Boolean(distortion.enabled),
      type: LINK_DISTORTION_TYPES.has(distortion.type) ? distortion.type : "soft-clip",
      gain: this.clamp(Number(distortion.gain) || 1.5, 0.1, 40),
    };
  }

  normalizeFollower(follower = {}) {
    return {
      attack: this.clamp(Number(follower.attack) || DEFAULT_LINK_FOLLOWER.attack, 0.001, 2),
      release: this.clamp(Number(follower.release) || DEFAULT_LINK_FOLLOWER.release, 0.001, 4),
    };
  }

  normalizeModulationTarget(target, to, targetLink = null, targetNode = null) {
    if (to === "audio") return "amplitude";
    if (targetLink) {
      const envelopeTargets = [...LINK_ENVELOPE_TARGETS];
      const targets = targetLink.to === "audio"
        ? ["amplitude", "pan", "noise", "delay", "filterCutoff", "filterResonance", "envelopeTrigger", ...envelopeTargets]
        : ["amplitude", "noise", "delay", "filterCutoff", "filterResonance", "envelopeTrigger", ...envelopeTargets];
      return targets.includes(target) ? target : "amplitude";
    }
    const targets = targetNode && OSCILLATOR_WAVE_TYPES.includes(targetNode.wave)
      ? ["phase", "phaseResetTrigger", "frequency", "wave", "ring", "fold", "mix"]
      : ["phase", "phaseResetTrigger", "frequency", "ring", "fold", "mix"];
    return targets.includes(target) ? target : "phase";
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

  syncLinkControlSmoother(link) {
    const target = this.linkControlTargets(link);
    const existing = this.linkControlSmoothers.get(link.id);
    if (existing) {
      existing.target = target;
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

  setLinkParam({ id, parameter, value } = {}) {
    const link = this.linksById.get(id);
    if (!link) return;

    if (parameter === "amount") {
      link.amount = this.clamp(Number(value) || 0, 0, 32);
    } else if (parameter === "delay") {
      link.delay = this.clamp(Number(value) || 0, 0, MAX_LINK_DELAY_SECONDS);
    } else if (parameter === "noise") {
      link.noise = this.clamp(Number(value) || 0, 0, 1);
    } else if (parameter === "pan") {
      link.pan = this.clamp(Number(value) || 0, -1, 1);
    } else if (parameter === "velocitySensitivity") {
      link.velocitySensitivity = this.clamp(
        Number(value) || 0,
        VELOCITY_SENSITIVITY_MIN,
        VELOCITY_SENSITIVITY_MAX,
      );
    } else if (parameter === "filter.cutoff") {
      const isComb = link.filter.type === "comb" || link.filter.type === "comb-notch";
      link.filter.cutoff = link.filter.type === "formant"
        ? this.clamp(Number.isFinite(Number(value)) ? Number(value) : 0, 0, 1)
        : this.clamp(Number(value) || (isComb ? 440 : 5000), 20, Math.min(isComb ? 5000 : 12000, sampleRate * 0.45));
    } else if (parameter === "filter.resonance") {
      const isComb = link.filter.type === "comb" || link.filter.type === "comb-notch";
      link.filter.resonance = this.clamp(
        Number.isFinite(Number(value)) ? Number(value) : isComb ? 0.45 : 0.7,
        isComb ? -0.98 : 0.1,
        link.filter.type === "formant" ? FORMANT_INTENSITY_MAX : isComb ? 0.98 : 12,
      );
    } else if (parameter === "distortion.gain") {
      link.distortion = {
        ...(link.distortion || this.normalizeLinkDistortion()),
        gain: this.clamp(Number(value) || 1.5, 0.1, 40),
      };
    } else {
      return;
    }

    link.controlSmoother = this.syncLinkControlSmoother(link);
  }

  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  smoothControlValue(current, target, alpha) {
    const next = current + (target - current) * alpha;
    return Math.abs(target - next) <= LINK_CONTROL_SETTLE_EPSILON ? target : next;
  }

  advanceLinkControlSmoothers() {
    if (!this.activeLinkControlSmoothers.size) return;

    for (const id of this.activeLinkControlSmoothers) {
      const smoother = this.linkControlSmoothers.get(id);
      const link = this.linksById.get(id);
      if (!smoother || !link) {
        this.activeLinkControlSmoothers.delete(id);
        continue;
      }

      const { current, target } = smoother;
      const alpha = this.linkControlSmoothAlpha;
      current.amount = this.smoothControlValue(current.amount, target.amount, alpha);
      current.delay = this.smoothControlValue(current.delay, target.delay, alpha);
      current.noise = this.smoothControlValue(current.noise, target.noise, alpha);
      current.pan = this.smoothControlValue(current.pan, target.pan, alpha);
      current.filterCutoff = this.smoothControlValue(current.filterCutoff, target.filterCutoff, alpha);
      current.filterResonance = this.smoothControlValue(current.filterResonance, target.filterResonance, alpha);
      current.distortionGain = this.smoothControlValue(current.distortionGain, target.distortionGain, alpha);
      link.baseParams = this.createBaseLinkParams(link);
      this.syncActiveLinkControlSmoother(smoother);
    }
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

  sanitizeSample(value, limit = 16) {
    if (!Number.isFinite(value)) return 0;
    if (Math.abs(value) < DENORMAL_EPSILON) return 0;
    return this.clamp(value, -limit, limit);
  }

  resetRuntimeState() {
    this.voices.clear();
    this.activeVoicesByNote.clear();
    this.pendingVoiceStarts = [];
    this.droneVoice = this.createVoice("drone", 440, 1, this.sampleCursor / sampleRate, true);
    this.chorusBuffers.forEach((buffer) => buffer.fill(0));
    this.chorusIndices = [0, 0];
    this.delayBuffers.forEach((buffer) => buffer.fill(0));
    this.delayIndices = [0, 0];
    this.reverbDelays = [this.createReverbDelays(), this.createReverbDelays()];
    this.inputDcBlockers = [this.createDcBlocker(), this.createDcBlocker()];
    this.outputDcBlockers = [this.createDcBlocker(), this.createDcBlocker()];
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

  createVoice(note, frequency, velocity = 1, startedAt = this.sampleCursor / sampleRate, isDrone = false) {
    const voice = {
      id: isDrone ? "drone" : `voice-${this.voiceCounter++}`,
      note,
      frequency,
      velocity: Math.max(0.05, Math.min(1, velocity)),
      startedAt,
      releasedAt: null,
      stolenAt: null,
      releaseLevels: new Map(),
      phases: new Map(),
      feedback: new Map(),
      linkFilters: new Map(),
      linkDelays: new Map(),
      nodeFilters: new Map(),
      frequencyMods: new Map(),
      quantisedFrequencyStates: new Map(),
      renderCache: new Map(),
      renderStack: new Set(),
      linkStack: new Set(),
      linkParamCache: new Map(),
      linkTriggerSigns: new Map(),
      linkTriggerArmed: new Map(),
      linkFollowers: new Map(),
      linkEnvelopeStarts: new Map(),
      linkEnvelopeStartLevels: new Map(),
      linkEnvelopeReleaseStarts: new Map(),
      linkEnvelopeReleaseLevels: new Map(),
      sampleHolds: new Map(),
      perlinStates: new Map(),
      customWaveDone: new Map(),
      customWaveDirections: new Map(),
      isDrone,
    };

    for (const node of this.nodes) {
      voice.phases.set(node.id, node.wave === "custom" ? 0 : Math.random());
      voice.feedback.set(node.id, { prev1: 0, prev2: 0 });
      if (node.wave === "sample-hold") {
        voice.sampleHolds.set(node.id, this.randomBipolar());
      }
      if (node.wave === "perlin") {
        voice.perlinStates.set(node.id, this.createPerlinState());
      }
    }

    return voice;
  }

  deleteVoice(voiceId) {
    this.voices.delete(voiceId);
    for (const [note, activeVoiceId] of this.activeVoicesByNote) {
      if (activeVoiceId === voiceId) {
        this.activeVoicesByNote.delete(note);
      }
    }
  }

  voiceStealCandidate() {
    let candidateId = null;
    let candidate = null;

    for (const [voiceId, voice] of this.voices) {
      if (voice.stolenAt !== null) continue;

      if (!candidate) {
        candidateId = voiceId;
        candidate = voice;
        continue;
      }

      const voiceReleased = voice.releasedAt !== null;
      const candidateReleased = candidate.releasedAt !== null;
      if (voiceReleased !== candidateReleased) {
        if (voiceReleased) {
          candidateId = voiceId;
          candidate = voice;
        }
        continue;
      }

      const voiceTime = voiceReleased ? voice.releasedAt : voice.startedAt;
      const candidateTime = candidateReleased ? candidate.releasedAt : candidate.startedAt;
      if (voiceTime < candidateTime) {
        candidateId = voiceId;
        candidate = voice;
      }
    }

    return candidateId;
  }

  activeVoiceCount() {
    let count = 0;
    for (const voice of this.voices.values()) {
      if (voice.stolenAt === null) count += 1;
    }
    return count;
  }

  stealVoiceForFade() {
    const voiceId = this.voiceStealCandidate();
    if (!voiceId) return false;
    const voice = this.voices.get(voiceId);
    if (!voice) return false;
    voice.stolenAt = this.sampleCursor / sampleRate;
    this.forgetActiveVoice(voiceId);
    return true;
  }

  enforceVoiceLimit(limit = this.maxVoices) {
    while (this.activeVoiceCount() > limit) {
      if (!this.stealVoiceForFade()) return;
    }
  }

  reserveVoiceSlot() {
    return this.stealVoiceForFade();
  }

  hardPruneStolenOverflow() {
    while (this.voices.size > this.maxVoices) {
      const stolenVoice = [...this.voices.entries()]
        .filter(([, voice]) => voice.stolenAt !== null)
        .sort(([, voiceA], [, voiceB]) => voiceA.stolenAt - voiceB.stolenAt)[0];
      const voiceId = stolenVoice?.[0] || this.voiceStealCandidate();
      if (!voiceId) return;
      this.deleteVoice(voiceId);
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

  startVoice(note, velocity = 1, startedAt = this.sampleCursor / sampleRate) {
    const voice = this.createVoice(
      note,
      440 * Math.pow(2, (note - 69) / 12),
      velocity,
      startedAt,
    );
    this.voices.set(voice.id, voice);
    this.activeVoicesByNote.set(note, voice.id);
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
        continue;
      }
      ready.push(pending);
    }

    if (!ready.length) {
      this.pendingVoiceStarts = remaining;
      return;
    }

    if (ready.length > this.maxVoices) {
      ready = ready.slice(ready.length - this.maxVoices);
    }

    const freeSlots = Math.max(0, this.maxVoices - this.voices.size);
    const slotsToReserve = Math.max(0, ready.length - freeSlots);
    if (slotsToReserve > 0) {
      let reservedSlots = 0;
      while (reservedSlots < slotsToReserve && this.reserveVoiceSlot()) {
        reservedSlots += 1;
      }

      const delayedReadyAt = this.latestStolenFadeEnd(now);
      this.pendingVoiceStarts = [
        ...remaining,
        ...ready.map((pending) => ({ ...pending, readyAt: delayedReadyAt })),
      ];
      return;
    }

    for (const pending of ready) {
      this.startVoice(pending.note, pending.velocity, now);
    }
    this.pendingVoiceStarts = remaining;
  }

  forgetActiveVoice(voiceId) {
    for (const [note, activeVoiceId] of this.activeVoicesByNote) {
      if (activeVoiceId === voiceId) {
        this.activeVoicesByNote.delete(note);
      }
    }
  }

  noteOn(note, velocity = 1) {
    const now = this.sampleCursor / sampleRate;
    const activeVoice = this.voices.get(this.activeVoicesByNote.get(note));
    if (activeVoice && activeVoice.releasedAt === null) {
      activeVoice.releasedAt = now;
      activeVoice.releaseLevels.clear();
    }

    this.queueVoiceStart(note, velocity, now + NOTE_ON_BATCH_SECONDS);
  }

  noteOff(note) {
    this.pendingVoiceStarts = this.pendingVoiceStarts.filter((pending) => pending.note !== note);
    const voiceId = this.activeVoicesByNote.get(note);
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    voice.releasedAt = this.sampleCursor / sampleRate;
    voice.releaseLevels.clear();
    this.activeVoicesByNote.delete(note);
  }

  velocityScale(link, voice) {
    const sensitivity = link.velocitySensitivity;
    if (sensitivity === 0) return 1;
    const velocity = voice.velocity;
    if (sensitivity < 0) {
      const invertedVelocity = this.clamp(1 - velocity, 0, 1);
      const depth = Math.abs(sensitivity);
      if (depth <= 1) {
        return 1 - depth + depth * invertedVelocity;
      }
      return Math.pow(invertedVelocity, depth);
    }
    if (sensitivity === 1) return velocity;
    if (sensitivity <= 1) {
      return 1 - sensitivity + sensitivity * velocity;
    }
    return Math.pow(velocity, sensitivity);
  }

  attackCurve(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  decayCurve(t) {
    return Math.pow(1 - t, 2);
  }

  smoothStep(t) {
    const x = this.clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  randomBipolar() {
    return Math.random() * 2 - 1;
  }

  createPerlinState() {
    return {
      current: this.randomBipolar(),
      next: this.randomBipolar(),
    };
  }

  perlinValue(voice, nodeId, phase) {
    if (!voice.perlinStates.has(nodeId)) {
      voice.perlinStates.set(nodeId, this.createPerlinState());
    }
    const state = voice.perlinStates.get(nodeId);
    const t = this.smoothStep(phase - Math.floor(phase));
    return state.current + (state.next - state.current) * t;
  }

  voiceLifecycleGain(voice, now) {
    const startGain = voice.isDrone
      ? 1
      : this.smoothStep((now - voice.startedAt) / VOICE_START_FADE_SECONDS);
    if (voice.stolenAt === null) return startGain;

    const stealFade = 1 - this.smoothStep((now - voice.stolenAt) / VOICE_STEAL_FADE_SECONDS);
    return startGain * stealFade;
  }

  heldEnvelopeValue(link, voice, time, envelope = link.envelope || DEFAULT_ENVELOPE) {
    const env = envelope;
    const delay = Math.max(0, env.delay || 0);
    const attack = Math.max(0.001, env.attack);
    const decay = Math.max(0.001, env.decay);
    const sustain = Math.max(0, Math.min(1, env.sustain));
    const envelopeStartedAt = voice.linkEnvelopeStarts.get(link.id) ?? voice.startedAt;
    const startLevel = this.clamp(voice.linkEnvelopeStartLevels?.get(link.id) ?? 0, 0, 1);

    let elapsed = Math.max(0, time - envelopeStartedAt);
    if (elapsed < delay) return startLevel;
    elapsed -= delay;
    if (elapsed < attack) {
      return startLevel + (1 - startLevel) * this.attackCurve(elapsed / attack);
    }
    if (elapsed < attack + decay) {
      const t = (elapsed - attack) / decay;
      return sustain + (1 - sustain) * this.decayCurve(t);
    }
    return sustain;
  }

  triggerLinkEnvelope(link, voice, now) {
    if (voice.stolenAt !== null) return;
    if (!voice.isDrone && voice.releasedAt !== null) return;
    const hasEnvelopeStart = voice.linkEnvelopeStarts.has(link.id);
    const currentLevel = voice.isDrone && !hasEnvelopeStart
      ? 0
      : this.linkEnvelopeValue(link, voice, now, link.envelope || DEFAULT_ENVELOPE);
    voice.linkEnvelopeStarts.set(link.id, now);
    voice.linkEnvelopeStartLevels.set(link.id, currentLevel);
    voice.linkEnvelopeReleaseStarts.delete(link.id);
    voice.linkEnvelopeReleaseLevels.delete(link.id);
    voice.releaseLevels.delete(link.id);
  }

  releaseLinkEnvelope(link, voice, now) {
    if (voice.stolenAt !== null) return;
    if (!voice.linkEnvelopeStarts.has(link.id)) return;
    const currentLevel = this.linkEnvelopeValue(link, voice, now, link.envelope || DEFAULT_ENVELOPE);
    voice.linkEnvelopeReleaseStarts.set(link.id, now);
    voice.linkEnvelopeReleaseLevels.set(link.id, currentLevel);
  }

  linkEnvelopeValue(link, voice, now, env = link.envelope || DEFAULT_ENVELOPE) {
    const releaseStartedAt = voice.linkEnvelopeReleaseStarts.get(link.id);
    if (releaseStartedAt !== undefined) {
      const release = Math.max(0.001, env.release);
      const releaseLevel = this.clamp(voice.linkEnvelopeReleaseLevels.get(link.id) ?? 0, 0, 1);
      const t = this.clamp((now - releaseStartedAt) / release, 0, 1);
      return Math.max(0, releaseLevel * this.decayCurve(t));
    }

    return this.heldEnvelopeValue(link, voice, now, env);
  }

  applyEnvelopeTrigger(modLink, targetLink, voice, now, value) {
    if (!Number.isFinite(value)) return;

    if (modLink.signalMode !== "raw") {
      const previousArmed = voice.linkTriggerArmed.get(modLink.id);
      if (previousArmed === undefined) {
        if (value >= ENVELOPE_TRIGGER_THRESHOLD) {
          this.triggerLinkEnvelope(targetLink, voice, now);
          voice.linkTriggerArmed.set(modLink.id, false);
        } else {
          voice.linkTriggerArmed.set(modLink.id, true);
        }
        return;
      }
      if (previousArmed && value >= ENVELOPE_TRIGGER_THRESHOLD) {
        this.triggerLinkEnvelope(targetLink, voice, now);
        voice.linkTriggerArmed.set(modLink.id, false);
        return;
      }
      if (!previousArmed && value <= ENVELOPE_TRIGGER_REARM) {
        this.releaseLinkEnvelope(targetLink, voice, now);
        voice.linkTriggerArmed.set(modLink.id, true);
      }
      return;
    }

    if (value === 0) return;
    const sign = value > 0 ? 1 : -1;
    const previousSign = voice.linkTriggerSigns.get(modLink.id) || 0;
    if (previousSign !== 0 && previousSign !== sign) {
      this.triggerLinkEnvelope(targetLink, voice, now);
    }
    voice.linkTriggerSigns.set(modLink.id, sign);
  }

  resetNodePhase(node, voice) {
    if (!node?.id || voice.stolenAt !== null) return;
    if (!voice.isDrone && voice.releasedAt !== null) return;
    voice.phases.set(node.id, 0);
    voice.customWaveDone.delete(node.id);
    voice.customWaveDirections.set(node.id, 1);
  }

  applyPhaseResetTrigger(modLink, targetNode, voice, value) {
    if (!Number.isFinite(value)) return;
    const previousArmed = voice.linkTriggerArmed.get(modLink.id);
    if (previousArmed === undefined) {
      if (value >= ENVELOPE_TRIGGER_THRESHOLD) {
        this.resetNodePhase(targetNode, voice);
        voice.linkTriggerArmed.set(modLink.id, false);
      } else {
        voice.linkTriggerArmed.set(modLink.id, true);
      }
      return;
    }
    if (previousArmed && value >= ENVELOPE_TRIGGER_THRESHOLD) {
      this.resetNodePhase(targetNode, voice);
      voice.linkTriggerArmed.set(modLink.id, false);
      return;
    }
    if (!previousArmed && value <= ENVELOPE_TRIGGER_REARM) {
      voice.linkTriggerArmed.set(modLink.id, true);
    }
  }

  envelopeValue(link, voice, now, params = link) {
    if (link.drone) return 1;
    if (voice.isDrone && !link.hasEnvelopeTriggers) return 0;
    if (voice.isDrone && !voice.linkEnvelopeStarts.has(link.id)) return 0;

    const env = params.envelope || link.envelope || DEFAULT_ENVELOPE;
    const release = Math.max(0.001, env.release);

    if (voice.releasedAt === null) {
      return this.linkEnvelopeValue(link, voice, now, env);
    }

    if (!voice.releaseLevels.has(link.id)) {
      voice.releaseLevels.set(link.id, this.linkEnvelopeValue(link, voice, voice.releasedAt, env));
    }

    const t = Math.max(0, Math.min(1, (now - voice.releasedAt) / release));
    return Math.max(0, voice.releaseLevels.get(link.id) * this.decayCurve(t));
  }

  oscillator(node, phase, voice, wave = node.wave) {
    const p = phase - Math.floor(phase);
    switch (wave) {
      case "triangle":
        return 1 - 4 * Math.abs(Math.round(p - 0.25) - (p - 0.25));
      case "saw":
        return 2 * p - 1;
      case "ramp":
        return 1 - 2 * p;
      case "square":
        return p < 0.5 ? 1 : -1;
      case "sample-hold":
        if (!voice.sampleHolds.has(node.id)) {
          voice.sampleHolds.set(node.id, this.randomBipolar());
        }
        return voice.sampleHolds.get(node.id);
      case "noise":
        return this.randomBipolar();
      case "perlin":
        return this.perlinValue(voice, node.id, p);
      case "custom":
        return this.customWaveValue(node, p);
      case "audio-input":
        return this.currentInputSample * node.audioInputGain;
      case "sine":
      default:
        return Math.sin(TWO_PI * p);
    }
  }

  customWaveValue(node, phase) {
    const points = node.customWave?.points || DEFAULT_CUSTOM_WAVE.points;
    if (points.length < 2) return 0;
    const p = this.clamp(phase, 0, 1);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const next = points[index];
      if (p > next.x && index < points.length - 1) continue;
      const span = next.x - previous.x;
      if (span <= 0) return next.y;
      const t = this.clamp((p - previous.x) / span, 0, 1);
      return previous.y + (next.y - previous.y) * t;
    }
    return points[points.length - 1].y;
  }

  customOneShotEdgeGain(node, phase, baseFrequency) {
    if (node.wave !== "custom" || !this.isCustomFiniteMode(node.customWave?.mode)) return 1;
    if (!(baseFrequency > 0)) return 1;
    const fadePhase = this.clamp(CUSTOM_ONESHOT_EDGE_FADE_SECONDS * baseFrequency, 0.0005, 0.08);
    const p = this.clamp(phase, 0, 1);
    return this.clamp(Math.min(p / fadePhase, (1 - p) / fadePhase), 0, 1);
  }

  isCustomFiniteMode(mode) {
    return ["once", "sustain", "sustain-loop", "sustain-ping-pong"].includes(mode);
  }

  advanceCustomWavePhase(node, voice, step) {
    const customWave = node.customWave || DEFAULT_CUSTOM_WAVE;
    const mode = customWave.mode || "loop";
    const released = voice.releasedAt !== null;
    const current = voice.phases.get(node.id) || 0;
    let direction = voice.customWaveDirections.get(node.id) || 1;
    let next = current;
    const start = this.clamp(customWave.sustainStart ?? 0.5, 0, 0.999);
    const end = this.clamp(customWave.sustainEnd ?? 0.75, start + 0.001, 1);
    const length = Math.max(0.001, end - start);
    const finish = (value) => {
      if (value >= 1) {
        voice.customWaveDone.set(node.id, true);
        voice.phases.set(node.id, 1);
      } else {
        voice.phases.set(node.id, this.clamp(value, 0, 1));
      }
      voice.customWaveDirections.set(node.id, direction);
    };

    if (mode === "ping-pong") {
      next = current + step * direction;
      if (next >= 1) {
        next = 1 - (next - 1);
        direction = -1;
      } else if (next <= 0) {
        next = -next;
        direction = 1;
      }
      finish(next);
      return;
    }

    if (mode === "once") {
      finish(current + step);
      return;
    }

    if (mode === "sustain") {
      next = current + step;
      if (!released && next >= start) next = start;
      finish(next);
      return;
    }

    if (mode === "sustain-loop") {
      next = current + step;
      if (!released) {
        if (next >= start) {
          next = start + (((next - start) % length) + length) % length;
        }
        finish(next);
        return;
      }
      finish(next);
      return;
    }

    if (mode === "sustain-ping-pong") {
      if (!released) {
        next = current + step * direction;
        if (next >= end) {
          next = end - (next - end);
          direction = -1;
        } else if (next <= start && current >= start) {
          next = start + (start - next);
          direction = 1;
        } else if (next >= start && current < start) {
          direction = 1;
        }
        finish(next);
        return;
      }
      next = current + step * direction;
      if (direction < 0 && next <= start) {
        next = start + (start - next);
        direction = 1;
      }
      finish(next);
      return;
    }

    voice.phases.set(node.id, Number.isFinite(current + step) ? (current + step) - Math.floor(current + step) : 0);
    voice.customWaveDirections.set(node.id, direction);
  }

  feedbackSignal(voice, nodeId) {
    const history = voice.feedback.get(nodeId);
    if (!history) return 0;
    return (history.prev1 + history.prev2) * 0.5;
  }

  storeFeedback(voice, nodeId, value) {
    const history = voice.feedback.get(nodeId) || { prev1: 0, prev2: 0 };
    history.prev2 = history.prev1;
    history.prev1 = this.sanitizeSample(value, 4);
    voice.feedback.set(nodeId, history);
  }

  linkFilterState(voice, link) {
    const key = link.filterStateKey || link.id;
    if (!voice.linkFilters.has(key)) {
      voice.linkFilters.set(key, { x1: 0, x2: 0, y1: 0, y2: 0 });
    }
    return voice.linkFilters.get(key);
  }

  filterCoefficients(filter) {
    const cutoff = this.clamp(Number(filter.cutoff) || 5000, 20, Math.min(12000, sampleRate * 0.45));
    const q = this.clamp(Number(filter.resonance) || 0.7, 0.1, 96);
    const omega = (TWO_PI * cutoff) / sampleRate;
    const sin = Math.sin(omega);
    const cos = Math.cos(omega);
    const alpha = sin / (2 * q);
    let b0 = 1;
    let b1 = 0;
    let b2 = 0;
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;

    if (filter.type === "lowpass") {
      b0 = (1 - cos) * 0.5;
      b1 = 1 - cos;
      b2 = (1 - cos) * 0.5;
    } else if (filter.type === "highpass") {
      b0 = (1 + cos) * 0.5;
      b1 = -(1 + cos);
      b2 = (1 + cos) * 0.5;
    } else if (filter.type === "bandpass") {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }

    return {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0,
    };
  }

  applyBiquadFilter(state, sample, coefficients) {
    const output = coefficients.b0 * sample
      + coefficients.b1 * state.x1
      + coefficients.b2 * state.x2
      - coefficients.a1 * state.y1
      - coefficients.a2 * state.y2;

    state.x2 = state.x1;
    state.x1 = this.sanitizeSample(sample, 4);
    state.y2 = state.y1;
    state.y1 = this.sanitizeSample(output, 4);
    return state.y1;
  }

  formantBands(morph, intensity) {
    const position = this.clamp(morph, 0, 1) * (FORMANT_VOWELS.length - 1);
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, FORMANT_VOWELS.length - 1);
    const t = position - leftIndex;
    const strength = this.clamp((intensity - 0.1) / 11.9, 0, 1);
    const overdrive = this.clamp((intensity - 12) / (FORMANT_INTENSITY_MAX - 12), 0, 1);
    const left = FORMANT_VOWELS[leftIndex];
    const right = FORMANT_VOWELS[rightIndex];

    return left.map((band, index) => {
      const next = right[index];
      const frequency = this.clamp(
        band.frequency * Math.pow(next.frequency / band.frequency, t),
        20,
        Math.min(12000, sampleRate * 0.45),
      );
      const q = this.clamp((band.q + (next.q - band.q) * t) * (0.7 + strength * 1.9 + overdrive * 4.2), 0.1, 96);
      const gainDb = band.gainDb + (next.gainDb - band.gainDb) * t + strength * 4 + overdrive * 18;
      return {
        frequency,
        q,
        gain: Math.pow(10, gainDb / 20),
      };
    });
  }

  applyFormantFilter(link, voice, sample, filter) {
    const state = this.linkFilterState(voice, link);
    if (!state.formants) {
      state.formants = FORMANT_VOWELS[0].map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
    }

    const intensity = this.clamp(Number(filter.resonance) || 0.7, 0.1, FORMANT_INTENSITY_MAX);
    const strength = this.clamp((intensity - 0.1) / 11.9, 0, 1);
    const overdrive = this.clamp((intensity - 12) / (FORMANT_INTENSITY_MAX - 12), 0, 1);
    const bands = this.formantBands(Number(filter.cutoff) || 0, intensity);
    let wet = 0;
    for (let index = 0; index < bands.length; index += 1) {
      const band = bands[index];
      const coefficients = this.filterCoefficients({
        type: "bandpass",
        cutoff: band.frequency,
        resonance: band.q,
      });
      wet += this.applyBiquadFilter(state.formants[index], sample, coefficients) * band.gain;
    }

    const dryMix = 0.42 - strength * 0.18 - overdrive * 0.16;
    const wetMix = 0.46 + strength * 0.38 + overdrive * 0.95;
    return this.sanitizeSample(sample * dryMix + wet * wetMix, 4);
  }

  applyCombFilter(link, voice, sample, filter) {
    const state = this.linkFilterState(voice, link);
    if (!state.combBuffer) {
      state.combBuffer = new Float32Array(Math.ceil(sampleRate / 20) + 2);
      state.combIndex = 0;
    }

    const frequency = this.clamp(Number(filter.cutoff) || 440, 20, Math.min(5000, sampleRate * 0.45));
    const delaySamples = this.clamp(sampleRate / frequency, 1, state.combBuffer.length - 1);
    const delayed = this.readDelay(state.combBuffer, state.combIndex, delaySamples);
    const feedback = this.clamp(Number.isFinite(Number(filter.resonance)) ? Number(filter.resonance) : 0.45, -0.98, 0.98);
    const cleanSample = this.sanitizeSample(sample, 4);
    const writeValue = this.sanitizeSample(cleanSample + delayed * feedback, 4);
    state.combBuffer[state.combIndex] = writeValue;
    state.combIndex = (state.combIndex + 1) % state.combBuffer.length;

    if (filter.type === "comb-notch") {
      return this.sanitizeSample(cleanSample - delayed * Math.abs(feedback || 0.45), 4);
    }
    return this.sanitizeSample(delayed, 4);
  }

  applyLinkFilter(link, voice, sample, filter = link.filter || { type: "none" }) {
    if (filter.type === "none") return sample;
    if (filter.type === "formant") return this.applyFormantFilter(link, voice, sample, filter);
    if (filter.type === "comb" || filter.type === "comb-notch") return this.applyCombFilter(link, voice, sample, filter);

    const state = this.linkFilterState(voice, link);
    const coefficients = filter.coefficients || this.filterCoefficients(filter);
    return this.applyBiquadFilter(state, sample, coefficients);
  }

  linkDelayState(voice, link) {
    if (!voice.linkDelays.has(link.id)) {
      voice.linkDelays.set(link.id, {
        buffer: new Float32Array(Math.ceil(sampleRate * MAX_LINK_DELAY_SECONDS) + 1),
        index: 0,
        wasDisabled: true,
      });
    }
    return voice.linkDelays.get(link.id);
  }

  applyLinkDelay(link, voice, sample, params = link) {
    const delay = this.clamp(Number(params.delay) || 0, 0, MAX_LINK_DELAY_SECONDS);
    const cleanSample = this.sanitizeSample(sample, 4);
    if (delay <= 0) {
      const existing = voice.linkDelays.get(link.id);
      if (link.hasDelayModulators) {
        const state = existing || this.linkDelayState(voice, link);
        state.buffer[state.index] = cleanSample;
        state.index = (state.index + 1) % state.buffer.length;
        state.wasDisabled = false;
      } else if (existing && !existing.wasDisabled) {
        existing.buffer.fill(0);
        existing.index = 0;
        existing.wasDisabled = true;
      }
      return cleanSample;
    }

    const state = this.linkDelayState(voice, link);
    if (state.wasDisabled) {
      state.buffer.fill(cleanSample);
      state.index = 0;
      state.wasDisabled = false;
    }
    const delayed = this.readDelay(state.buffer, state.index, Math.max(1, delay * sampleRate));
    state.buffer[state.index] = cleanSample;
    state.index = (state.index + 1) % state.buffer.length;
    return delayed;
  }

  nodeFilterState(voice, nodeId) {
    if (!voice.nodeFilters.has(nodeId)) {
      voice.nodeFilters.set(nodeId, { x1: 0, x2: 0, y1: 0, y2: 0 });
    }
    return voice.nodeFilters.get(nodeId);
  }

  applyNodeFilter(nodeId, voice, sample, cutoffMod, enabled) {
    if (!enabled) return sample;
    const cutoff = this.clamp(2200 * Math.pow(2, this.clamp(cutoffMod, -5, 5)), 40, Math.min(12000, sampleRate * 0.45));
    const state = this.nodeFilterState(voice, nodeId);
    const coefficients = this.filterCoefficients({ type: "lowpass", cutoff, resonance: 0.9 });
    const output = coefficients.b0 * sample
      + coefficients.b1 * state.x1
      + coefficients.b2 * state.x2
      - coefficients.a1 * state.y1
      - coefficients.a2 * state.y2;

    state.x2 = state.x1;
    state.x1 = this.sanitizeSample(sample, 4);
    state.y2 = state.y1;
    state.y1 = this.sanitizeSample(output, 4);
    return state.y1;
  }

  foldSample(sample, drive) {
    const wrapped = ((sample * drive + 1) % 4 + 4) % 4;
    return wrapped <= 2 ? wrapped - 1 : 3 - wrapped;
  }

  applyLinkDistortion(sample, distortion = {}) {
    if (!distortion.enabled) return sample;
    const gain = this.clamp(Number(distortion.gain) || 1.5, 0.1, 40);
    const driven = this.sanitizeSample(sample * gain, 32);
    let output = driven;
    if (distortion.type === "hard-clip") {
      output = this.clamp(driven, -1, 1);
    } else if (distortion.type === "fuzz") {
      output = Math.sign(driven) * (1 - Math.exp(-Math.abs(driven) * 2.6));
      output += (Math.random() * 2 - 1) * Math.min(0.08, gain * 0.002);
    } else if (distortion.type === "saturate") {
      output = driven / (1 + Math.abs(driven));
    } else if (distortion.type === "wavefold") {
      output = this.foldSample(sample, gain);
    } else {
      output = Math.tanh(driven);
    }
    return this.sanitizeSample(output / Math.sqrt(gain), 4);
  }

  createBaseLinkParams(link) {
    const controls = link.controlSmoother?.current || this.linkControlTargets(link);
    const panGains = this.panGains(controls.pan);
    const filter = {
      ...link.filter,
      cutoff: controls.filterCutoff,
      resonance: controls.filterResonance,
    };
    filter.coefficients = filter.type === "none" || filter.type === "formant" ? null : this.filterCoefficients(filter);
    if (filter.type === "comb" || filter.type === "comb-notch") filter.coefficients = null;
    return {
      amount: controls.amount,
      delay: controls.delay,
      noise: controls.noise,
      pan: controls.pan,
      panGains,
      filter,
      distortion: {
        ...(link.distortion || this.normalizeLinkDistortion()),
        gain: controls.distortionGain,
      },
      envelope: link.envelope || DEFAULT_ENVELOPE,
    };
  }

  effectiveLinkParams(link, voice, now, cache, stack, linkStack = new Set()) {
    const baseParams = link.baseParams || this.createBaseLinkParams(link);
    if (!link.hasModulators || linkStack.has(link.id)) return baseParams;

    const canUseCache = linkStack.size === 0;
    const cachedParams = canUseCache ? voice.linkParamCache.get(link.id) : null;
    if (cachedParams) return cachedParams;

    const params = {
      amount: baseParams.amount,
      delay: baseParams.delay,
      noise: baseParams.noise,
      pan: baseParams.pan,
      panGains: baseParams.panGains,
      filter: baseParams.filter,
      distortion: baseParams.distortion,
      envelope: baseParams.envelope,
    };

    let cutoffMod = 0;
    let resonanceMod = 0;
    let amplitudeMod = 0;
    let delayMod = 0;
    let noiseMod = 0;
    let panMod = 0;
    const envelopeMods = {
      delay: 0,
      attack: 0,
      decay: 0,
      sustain: 0,
      release: 0,
    };
    const modulators = link.modulators;

    linkStack.add(link.id);
    for (const modLink of modulators) {
      const source = this.renderNode(modLink.from, voice, now, cache, stack, linkStack);
      const modulation = this.linkModulationSignal(modLink, voice, now, source, cache, stack, linkStack, {
        ignoreEnvelope: modLink.modulationTarget === "envelopeTrigger",
      });
      if (modLink.modulationTarget === "filterResonance") {
        resonanceMod += modulation.value;
      } else if (modLink.modulationTarget === "amplitude") {
        amplitudeMod += modulation.value;
      } else if (modLink.modulationTarget === "delay") {
        delayMod += modulation.value;
      } else if (modLink.modulationTarget === "noise") {
        noiseMod += modulation.value;
      } else if (modLink.modulationTarget === "pan") {
        panMod += modulation.value;
      } else if (modLink.modulationTarget === "envelopeTrigger") {
        this.applyEnvelopeTrigger(modLink, link, voice, now, modulation.value);
      } else if (LINK_ENVELOPE_TARGETS.has(modLink.modulationTarget)) {
        envelopeMods[modLink.modulationTarget.slice("envelope.".length)] += modulation.value;
      } else {
        cutoffMod += modulation.value;
      }
    }
    linkStack.delete(link.id);

    params.amount = this.clamp(params.amount * this.clamp(1 + amplitudeMod, 0, 4), 0, 32);
    params.delay = this.clamp(params.delay + delayMod, 0, MAX_LINK_DELAY_SECONDS);
    params.noise = this.clamp(params.noise + noiseMod, 0, 1);
    params.pan = this.clamp(params.pan + panMod, -1, 1);
    params.panGains = panMod === 0 ? baseParams.panGains : this.panGains(params.pan);
    params.filter = {
      type: params.filter.type,
      cutoff: params.filter.type === "formant"
        ? this.clamp(params.filter.cutoff + cutoffMod, 0, 1)
        : this.clamp(params.filter.cutoff * Math.pow(2, this.clamp(cutoffMod, -5, 5)), 20, Math.min(12000, sampleRate * 0.45)),
      resonance: this.clamp(
        params.filter.resonance + resonanceMod,
        0.1,
        params.filter.type === "formant" ? FORMANT_INTENSITY_MAX : 12,
      ),
    };
    if (cutoffMod === 0 && resonanceMod === 0) {
      params.filter = baseParams.filter;
    }
    if (
      envelopeMods.delay !== 0
      || envelopeMods.attack !== 0
      || envelopeMods.decay !== 0
      || envelopeMods.sustain !== 0
      || envelopeMods.release !== 0
    ) {
      const envelope = baseParams.envelope || DEFAULT_ENVELOPE;
      params.envelope = {
        delay: this.clamp((Number(envelope.delay) || 0) + envelopeMods.delay, 0, 4),
        attack: this.clamp((Number(envelope.attack) || 0.001) + envelopeMods.attack, 0.001, 4),
        decay: this.clamp((Number(envelope.decay) || 0.001) + envelopeMods.decay, 0.001, 4),
        sustain: this.clamp((Number(envelope.sustain) || 0) + envelopeMods.sustain, 0, 1),
        release: this.clamp((Number(envelope.release) || 0.001) + envelopeMods.release, 0.001, 6),
      };
    }
    if (canUseCache) {
      voice.linkParamCache.set(link.id, params);
    }
    return params;
  }

  applyLinkNoise(sample, params) {
    const noise = this.clamp(Number(params.noise) || 0, 0, 1);
    if (noise <= 0) return this.sanitizeSample(sample, 4);
    return this.sanitizeSample(sample + (Math.random() * 2 - 1) * noise, 4);
  }

  applyLinkSignalMode(link, voice, sample) {
    if (link.signalMode === "raw") return sample;

    let state = voice.linkFollowers.get(link.id);
    if (!state) {
      state = { value: 0, sampleCursor: -1, input: 0, output: 0 };
      voice.linkFollowers.set(link.id, state);
    }
    if (state.sampleCursor === this.sampleCursor && state.input === sample) {
      return state.output;
    }

    const input = this.clamp(Math.abs(sample), 0, 1);
    const follower = link.follower || DEFAULT_LINK_FOLLOWER;
    const time = input > state.value ? follower.attack : follower.release;
    const alpha = 1 - Math.exp(-1 / (sampleRate * Math.max(0.001, time)));
    state.value = this.clamp(state.value + (input - state.value) * alpha, 0, 1);
    state.sampleCursor = this.sampleCursor;
    state.input = sample;
    state.output = link.signalMode === "inverted-envelope" ? 1 - state.value : state.value;
    return state.output;
  }

  observeLinkMeter(link, inputSignal, outputSignal, envelopeSignal = 0) {
    if (!link?.id) return;
    const input = Number.isFinite(inputSignal) ? this.clamp(Math.abs(inputSignal), 0, 1) : 0;
    const output = Number.isFinite(outputSignal) ? this.clamp(Math.abs(outputSignal), 0, 1) : 0;
    const envelope = Number.isFinite(envelopeSignal) ? this.clamp(Math.abs(envelopeSignal), 0, 1) : 0;
    let peak = this.linkMeterPeaks.get(link.id);
    if (!peak) {
      peak = { input: 0, output: 0, envelope: 0 };
      this.linkMeterPeaks.set(link.id, peak);
    }
    if (input > peak.input) peak.input = input;
    if (output > peak.output) peak.output = output;
    if (envelope > peak.envelope) peak.envelope = envelope;
  }

  flushLinkMeters() {
    if (this.sampleCursor < this.nextLinkMeterPostSample) return;
    this.nextLinkMeterPostSample = this.sampleCursor + Math.max(1, Math.round(sampleRate * LINK_METER_POST_SECONDS));
    if (!this.links.length) return;

    const levels = this.links.map((link) => {
      const peak = this.linkMeterPeaks.get(link.id) || { input: 0, output: 0, envelope: 0 };
      return [
        link.id,
        this.clamp(peak.input || 0, 0, 1),
        this.clamp(peak.output || 0, 0, 1),
        this.clamp(peak.envelope || 0, 0, 1),
      ];
    });
    this.linkMeterPeaks.clear();
    this.port.postMessage({
      type: "linkMeters",
      payload: { levels },
    });
  }

  linkModulationSignal(link, voice, now, source, cache, stack, linkStack = new Set(), options = {}) {
    const params = this.effectiveLinkParams(link, voice, now, cache, stack, linkStack);
    const shapedSource = this.applyLinkFilter(link, voice, source, params.filter);
    const signalSource = this.applyLinkSignalMode(link, voice, shapedSource);
    const noisySource = this.applyLinkNoise(signalSource, params);
    const distortedSource = this.applyLinkDistortion(noisySource, params.distortion);
    const envelope = options.ignoreEnvelope ? 1 : this.envelopeValue(link, voice, now, params);
    const delayed = this.applyLinkDelay(
      link,
      voice,
      distortedSource * envelope * this.velocityScale(link, voice),
      params,
    );
    this.observeLinkMeter(link, source, delayed * params.amount, envelope);
    return {
      signal: delayed,
      amount: params.amount,
      value: delayed * params.amount,
    };
  }

  linkModulationValue(link, voice, now, source, cache, stack, linkStack = new Set()) {
    return this.linkModulationSignal(link, voice, now, source, cache, stack, linkStack).value;
  }

  panGains(pan) {
    const angle = (this.clamp(Number(pan) || 0, -1, 1) + 1) * Math.PI * 0.25;
    return {
      left: Math.cos(angle),
      right: Math.sin(angle),
    };
  }

  baseFrequency(node, voice) {
    return node.frequencyMode === "fixed"
      ? node.frequency
      : voice.frequency * (Number.isFinite(node.ratio) ? node.ratio : 1);
  }

  renderNode(nodeId, voice, now, cache, stack, linkStack = new Set()) {
    if (cache.has(nodeId)) return cache.get(nodeId);
    if (stack.has(nodeId)) return this.feedbackSignal(voice, nodeId);

    const node = this.nodesById.get(nodeId);
    if (!node) return 0;

    stack.add(nodeId);
    const baseFrequency = this.baseFrequency(node, voice);
    let phaseMod = 0;
    let frequencyMod = 0;
    let waveMod = 0;
    let foldDrive = 0;
    let mixAmount = 0;
    let mixSignal = 0;
    const ringMods = [];
    const incoming = this.incoming.get(nodeId) || [];

    for (const link of incoming) {
      const source = link.from === nodeId
        ? this.feedbackSignal(voice, nodeId)
        : this.renderNode(link.from, voice, now, cache, stack, linkStack);
      const modulation = this.linkModulationSignal(link, voice, now, source, cache, stack, linkStack, {
        ignoreEnvelope: link.modulationTarget === "phaseResetTrigger",
      });
      if (link.modulationTarget === "frequency") {
        frequencyMod += modulation.value;
      } else if (link.modulationTarget === "phaseResetTrigger") {
        this.applyPhaseResetTrigger(link, node, voice, modulation.value);
      } else if (link.modulationTarget === "wave") {
        waveMod += modulation.value;
      } else if (link.modulationTarget === "ring") {
        ringMods.push(modulation);
      } else if (link.modulationTarget === "fold") {
        foldDrive += Math.abs(modulation.value);
      } else if (link.modulationTarget === "mix") {
        const amount = Math.max(0, modulation.amount);
        mixAmount += amount;
        mixSignal += modulation.signal * amount;
      } else {
        phaseMod += modulation.value;
      }
    }

    if (!voice.phases.has(nodeId)) {
      voice.phases.set(nodeId, Math.random());
    }

    const phase = voice.phases.get(nodeId);
    const isOneShotDone = node.wave === "custom"
      && this.isCustomFiniteMode(node.customWave?.mode)
      && voice.customWaveDone.get(node.id);
    const isActiveWave = PITCHED_WAVE_TYPES.has(node.wave) ? baseFrequency > 0 : true;
    const wave = this.modulatedWave(node.wave, waveMod);
    let value = isActiveWave && !isOneShotDone ? this.oscillator(node, phase + phaseMod, voice, wave) : 0;
    value *= this.customOneShotEdgeGain(node, phase, baseFrequency);
    for (const modulation of ringMods) {
      const depth = this.clamp(modulation.amount, 0, 1);
      value = this.sanitizeSample(value * (1 - depth) + value * modulation.signal * depth, 4);
    }
    if (foldDrive > 0) {
      value = this.sanitizeSample(this.foldSample(value, 1 + this.clamp(foldDrive, 0, 8) * 3), 4);
    }
    if (mixAmount > 0) {
      const mix = this.clamp(mixAmount, 0, 1);
      const carrierGain = mix <= 0.5 ? 1 : 1 - (mix - 0.5) * 2;
      const modulatorGain = mix >= 0.5 ? 1 : mix * 2;
      value = this.sanitizeSample(value * carrierGain + (mixSignal / mixAmount) * modulatorGain, 4);
    }
    voice.frequencyMods.set(nodeId, frequencyMod);
    value = this.sanitizeSample(value, 4);
    cache.set(nodeId, value);
    this.storeFeedback(voice, nodeId, value);
    stack.delete(nodeId);
    return value;
  }

  modulatedWave(baseWave, modulation) {
    const baseIndex = OSCILLATOR_WAVE_TYPES.indexOf(baseWave);
    if (baseIndex === -1 || !Number.isFinite(modulation)) return baseWave;
    const index = this.clamp(Math.round(baseIndex + modulation), 0, OSCILLATOR_WAVE_TYPES.length - 1);
    return OSCILLATOR_WAVE_TYPES[index];
  }

  quantiseFrequency(frequency, quantise) {
    if (!quantise?.enabled || frequency <= 0 || !Number.isFinite(frequency)) return frequency;
    const intervals = QUANTISE_SCALE_INTERVALS[quantise.scale] || QUANTISE_SCALE_INTERVALS.chromatic;
    const root = QUANTISE_ROOT_NOTES.indexOf(quantise.root);
    const rootPitchClass = root >= 0 ? root : 0;
    const midi = 69 + 12 * Math.log2(frequency / 440);
    const center = Math.round(midi);
    let bestMidi = center;
    let bestDistance = Infinity;
    for (let octave = -2; octave <= 2; octave += 1) {
      const octaveBase = Math.floor(center / 12) * 12 + octave * 12;
      for (const interval of intervals) {
        const candidate = octaveBase + ((rootPitchClass + interval) % 12);
        const distance = Math.abs(candidate - midi);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestMidi = candidate;
        }
      }
    }
    return 440 * Math.pow(2, (bestMidi - 69) / 12);
  }

  glideFrequency(node, voice, target) {
    if (!node.quantise?.enabled || !PITCHED_WAVE_TYPES.has(node.wave)) return target;
    const glide = this.clamp(Number(node.quantise.glide) || 0, 0, 4);
    if (glide <= 0) {
      voice.quantisedFrequencyStates.set(node.id, { current: target, target, step: 0, remaining: 0 });
      return target;
    }
    let state = voice.quantisedFrequencyStates.get(node.id);
    if (!state || !Number.isFinite(state.current) || state.current <= 0) {
      state = { current: target, target, step: 0, remaining: 0 };
      voice.quantisedFrequencyStates.set(node.id, state);
      return target;
    }
    if (Math.abs(target - state.target) > 0.000001) {
      state.target = target;
      state.remaining = Math.max(1, Math.round(glide * sampleRate));
      state.step = (target - state.current) / state.remaining;
    }
    if (state.remaining > 0) {
      state.current += state.step;
      state.remaining -= 1;
      if (state.remaining <= 0) state.current = state.target;
    }
    return state.current;
  }

  advancePhases(voice) {
    for (const node of this.nodes) {
      if (node.wave === "noise" || node.wave === "audio-input") continue;
      const frequencyMod = PITCHED_WAVE_TYPES.has(node.wave)
        ? this.clamp(voice.frequencyMods.get(node.id) || 0, -5, 5)
        : 0;
      const frequencyMultiplier = Math.pow(2, frequencyMod);
      const baseFrequency = SPEED_WAVE_TYPES.has(node.wave)
        ? this.clamp(Number(node.speed) || 8, 0.01, 60)
        : this.baseFrequency(node, voice);
      const targetFrequency = PITCHED_WAVE_TYPES.has(node.wave)
        ? this.quantiseFrequency(baseFrequency * frequencyMultiplier, node.quantise)
        : baseFrequency * frequencyMultiplier;
      const effectiveFrequency = this.glideFrequency(node, voice, targetFrequency);
      const current = voice.phases.get(node.id) || 0;
      const next = current + effectiveFrequency / sampleRate;
      if (node.wave === "custom") {
        this.advanceCustomWavePhase(node, voice, effectiveFrequency / sampleRate);
        continue;
      }
      if (node.wave === "sample-hold" && next >= 1) {
        voice.sampleHolds.set(node.id, this.randomBipolar());
      }
      if (node.wave === "perlin" && next >= 1) {
        const state = voice.perlinStates.get(node.id) || this.createPerlinState();
        state.current = state.next;
        state.next = this.randomBipolar();
        voice.perlinStates.set(node.id, state);
      }
      voice.phases.set(node.id, Number.isFinite(next) ? next - Math.floor(next) : 0);
    }
  }

  pruneVoices(now) {
    let longestRelease = 0.05;
    for (const link of this.links) {
      longestRelease = Math.max(longestRelease, (link.envelope?.release || 0.05) + (link.delay || 0));
    }
    for (const [voiceId, voice] of this.voices) {
      const stealFinished = voice.stolenAt !== null && now - voice.stolenAt > VOICE_STEAL_FADE_SECONDS;
      const releaseFinished = voice.releasedAt !== null && now - voice.releasedAt > longestRelease + 0.08;
      if (stealFinished || releaseFinished) {
        this.deleteVoice(voiceId);
      }
    }
    this.enforceVoiceLimit();
    this.hardPruneStolenOverflow();
    this.flushPendingVoiceStarts(now);
  }

  renderVoice(voice, now) {
    const cache = voice.renderCache;
    const stack = voice.renderStack;
    const linkStack = voice.linkStack;
    cache.clear();
    stack.clear();
    linkStack.clear();
    voice.linkParamCache.clear();
    let voiceLeft = 0;
    let voiceRight = 0;
    voice.frequencyMods.clear();

    for (const link of this.outputLinks) {
      stack.clear();
      linkStack.clear();
      const params = this.effectiveLinkParams(link, voice, now, cache, stack, linkStack);
      const source = this.renderNode(link.from, voice, now, cache, stack, linkStack);
      const filteredSource = this.applyLinkFilter(link, voice, source, params.filter);
      const signalSource = this.applyLinkSignalMode(link, voice, filteredSource);
      const noisySource = this.applyLinkNoise(signalSource, params);
      const envelope = this.envelopeValue(link, voice, now, params);
      const delayedSource = this.applyLinkDelay(link, voice, noisySource * envelope * this.velocityScale(link, voice), params);
      const linkSample = delayedSource * params.amount;
      this.observeLinkMeter(link, source, linkSample, envelope);
      const pan = params.panGains;
      voiceLeft = this.sanitizeSample(voiceLeft + linkSample * pan.left, 8);
      voiceRight = this.sanitizeSample(voiceRight + linkSample * pan.right, 8);
    }

    this.advancePhases(voice);
    const lifecycleGain = this.voiceLifecycleGain(voice, now);
    return {
      left: Math.tanh(voiceLeft) * lifecycleGain,
      right: Math.tanh(voiceRight) * lifecycleGain,
    };
  }

  process(_inputs, outputs) {
    const input = _inputs[0];
    const inputLeft = input?.[0];
    const inputRight = input?.[1] || inputLeft;
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];

    for (let i = 0; i < left.length; i += 1) {
      const now = this.sampleCursor / sampleRate;
      this.advanceLinkControlSmoothers();
      this.currentInputSample = inputLeft
        ? ((inputLeft[i] || 0) + (inputRight?.[i] || 0)) * 0.5
        : 0;
      let leftSample = 0;
      let rightSample = 0;

      for (const voice of this.voices.values()) {
        const rendered = this.renderVoice(voice, now);
        leftSample = this.sanitizeSample(leftSample + rendered.left, 8);
        rightSample = this.sanitizeSample(rightSample + rendered.right, 8);
      }

      if (this.hasActiveDroneLinks) {
        const rendered = this.renderVoice(this.droneVoice, now);
        leftSample = this.sanitizeSample(leftSample + rendered.left, 8);
        rightSample = this.sanitizeSample(rightSample + rendered.right, 8);
      }

      left[i] = this.applyMasterEffects(Math.tanh(leftSample * this.masterGain), 0);
      right[i] = this.applyMasterEffects(Math.tanh(rightSample * this.masterGain), 1);
      this.sampleCursor += 1;
    }

    this.pruneVoices(this.sampleCursor / sampleRate);
    this.flushLinkMeters();
    return true;
  }
}

registerProcessor("visual-fm-engine", VisualFmEngine);
