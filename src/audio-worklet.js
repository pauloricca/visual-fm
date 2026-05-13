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
const DENORMAL_EPSILON = 1e-20;
const MASTER_DC_BLOCK_HZ = 10;
const EMPTY_LINKS = Object.freeze([]);
const WAVE_TYPES = new Set(["sine", "triangle", "saw", "ramp", "square", "sample-hold", "noise", "perlin", "audio-input"]);
const PITCHED_WAVE_TYPES = new Set(["sine", "triangle", "saw", "ramp", "square", "sample-hold"]);
const SPEED_WAVE_TYPES = new Set(["perlin"]);
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
    this.voices = new Map();
    this.activeVoicesByNote = new Map();
    this.pendingVoiceStarts = [];
    this.maxVoices = DEFAULT_MAX_ACTIVE_VOICES;
    this.voiceCounter = 1;
    this.droneVoice = this.createVoice("drone", 440, 1, 0, true);
    this.hasActiveDroneLinks = false;
    this.sampleCursor = 0;
    this.currentInputSample = 0;
    this.masterGain = 0.18;
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
      const filter = this.normalizeLinkFilter(link.filter);
      const normalized = {
        ...link,
        modulationTarget: this.normalizeModulationTarget(link.modulationTarget, link.to, targetLink),
        drone: Boolean(link.drone),
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
      };
      normalized.filter = filter;
      normalized.filterStateKey = `${normalized.id}:${filter.type}`;
      normalized.baseParams = this.createBaseLinkParams(normalized);
      normalized.modulators = EMPTY_LINKS;
      normalized.hasModulators = false;
      return normalized;
    });
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
    if (!voice.linkDelays) voice.linkDelays = new Map();
    if (!voice.renderCache) voice.renderCache = new Map();
    if (!voice.renderStack) voice.renderStack = new Set();
    if (!voice.linkStack) voice.linkStack = new Set();
    if (!voice.linkParamCache) voice.linkParamCache = new Map();
    if (!voice.linkTriggerSigns) voice.linkTriggerSigns = new Map();
    if (!voice.linkEnvelopeStarts) voice.linkEnvelopeStarts = new Map();
    if (!voice.sampleHolds) voice.sampleHolds = new Map();
    if (!voice.perlinStates) voice.perlinStates = new Map();

    const nodeIds = new Set(this.nodes.map((node) => node.id));
    const linkIds = new Set(this.links.map((link) => link.id));

    for (const key of voice.phases.keys()) {
      if (!nodeIds.has(key)) voice.phases.delete(key);
    }
    for (const key of voice.feedback.keys()) {
      if (!nodeIds.has(key)) voice.feedback.delete(key);
    }
    for (const key of voice.nodeFilters.keys()) {
      if (!nodeIds.has(key)) voice.nodeFilters.delete(key);
    }
    for (const key of voice.frequencyMods.keys()) {
      if (!nodeIds.has(key)) voice.frequencyMods.delete(key);
    }
    for (const key of voice.sampleHolds.keys()) {
      if (!nodeIds.has(key)) voice.sampleHolds.delete(key);
    }
    for (const key of voice.perlinStates.keys()) {
      if (!nodeIds.has(key)) voice.perlinStates.delete(key);
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
    for (const key of voice.linkEnvelopeStarts.keys()) {
      if (!linkIds.has(key)) voice.linkEnvelopeStarts.delete(key);
    }
    for (const key of voice.releaseLevels.keys()) {
      if (!linkIds.has(key)) voice.releaseLevels.delete(key);
    }

    for (const node of this.nodes) {
      if (!voice.phases.has(node.id)) {
        voice.phases.set(node.id, Math.random());
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
    }
  }

  normalizeNode(node = {}) {
    const ratio = Number(node.ratio);
    const frequency = Number(node.frequency);
    const speed = Number(node.speed);
    return {
      id: node.id,
      wave: WAVE_TYPES.has(node.wave) ? node.wave : "sine",
      frequencyMode: node.frequencyMode === "fixed" ? "fixed" : "ratio",
      ratio: Number.isFinite(ratio) ? this.clamp(ratio, 0, 16) : 1,
      frequency: Number.isFinite(frequency) ? this.clamp(frequency, 0, Math.min(12000, sampleRate * 0.45)) : 440,
      speed: Number.isFinite(speed) ? this.clamp(speed, 0.01, 60) : 8,
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
    const type = ["none", "lowpass", "highpass", "bandpass"].includes(filter.type) ? filter.type : "none";
    const normalized = {
      type,
      cutoff: this.clamp(Number(filter.cutoff) || 5000, 20, Math.min(12000, sampleRate * 0.45)),
      resonance: this.clamp(Number(filter.resonance) || 0.7, 0.1, 12),
    };
    normalized.coefficients = type === "none" ? null : this.filterCoefficients(normalized);
    return normalized;
  }

  normalizeModulationTarget(target, to, targetLink = null) {
    if (to === "audio") return "amplitude";
    if (targetLink) {
      const envelopeTargets = [...LINK_ENVELOPE_TARGETS];
      const targets = targetLink.to === "audio"
        ? ["amplitude", "pan", "noise", "delay", "filterCutoff", "filterResonance", "envelopeTrigger", ...envelopeTargets]
        : ["amplitude", "noise", "delay", "filterCutoff", "filterResonance", "envelopeTrigger", ...envelopeTargets];
      return targets.includes(target) ? target : "amplitude";
    }
    return ["phase", "frequency", "ring", "fold", "mix"].includes(target) ? target : "phase";
  }

  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
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
      renderCache: new Map(),
      renderStack: new Set(),
      linkStack: new Set(),
      linkParamCache: new Map(),
      linkTriggerSigns: new Map(),
      linkEnvelopeStarts: new Map(),
      sampleHolds: new Map(),
      perlinStates: new Map(),
      isDrone,
    };

    for (const node of this.nodes) {
      voice.phases.set(node.id, Math.random());
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

    let elapsed = Math.max(0, time - envelopeStartedAt);
    if (elapsed < delay) return 0;
    elapsed -= delay;
    if (elapsed < attack) return this.attackCurve(elapsed / attack);
    if (elapsed < attack + decay) {
      const t = (elapsed - attack) / decay;
      return sustain + (1 - sustain) * this.decayCurve(t);
    }
    return sustain;
  }

  triggerLinkEnvelope(link, voice, now) {
    if (voice.stolenAt !== null) return;
    if (!voice.isDrone && voice.releasedAt !== null) return;
    voice.linkEnvelopeStarts.set(link.id, now);
    voice.releaseLevels.delete(link.id);
  }

  applyEnvelopeTrigger(modLink, targetLink, voice, now, value) {
    if (!Number.isFinite(value) || value === 0) return;

    const sign = value > 0 ? 1 : -1;
    const previousSign = voice.linkTriggerSigns.get(modLink.id) || 0;
    if (previousSign !== 0 && previousSign !== sign) {
      this.triggerLinkEnvelope(targetLink, voice, now);
    }
    voice.linkTriggerSigns.set(modLink.id, sign);
  }

  envelopeValue(link, voice, now, params = link) {
    if (link.drone) return 1;
    if (voice.isDrone && !link.hasEnvelopeTriggers) return 0;
    if (voice.isDrone && !voice.linkEnvelopeStarts.has(link.id)) return 0;

    const env = params.envelope || link.envelope || DEFAULT_ENVELOPE;
    const release = Math.max(0.001, env.release);

    if (voice.releasedAt === null) {
      return this.heldEnvelopeValue(link, voice, now, env);
    }

    if (!voice.releaseLevels.has(link.id)) {
      voice.releaseLevels.set(link.id, this.heldEnvelopeValue(link, voice, voice.releasedAt, env));
    }

    const t = Math.max(0, Math.min(1, (now - voice.releasedAt) / release));
    return Math.max(0, voice.releaseLevels.get(link.id) * this.decayCurve(t));
  }

  oscillator(node, phase, voice) {
    const p = phase - Math.floor(phase);
    switch (node.wave) {
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
      case "audio-input":
        return this.currentInputSample;
      case "sine":
      default:
        return Math.sin(TWO_PI * p);
    }
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
    const q = this.clamp(Number(filter.resonance) || 0.7, 0.1, 12);
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

  applyLinkFilter(link, voice, sample, filter = link.filter || { type: "none" }) {
    if (filter.type === "none") return sample;

    const state = this.linkFilterState(voice, link);
    const coefficients = filter.coefficients || this.filterCoefficients(filter);
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
    if (delay <= 0) {
      const existing = voice.linkDelays.get(link.id);
      if (existing && !existing.wasDisabled) {
        existing.buffer.fill(0);
        existing.index = 0;
        existing.wasDisabled = true;
      }
      return sample;
    }

    const state = this.linkDelayState(voice, link);
    if (state.wasDisabled) {
      state.buffer.fill(0);
      state.index = 0;
      state.wasDisabled = false;
    }
    const delayed = this.readDelay(state.buffer, state.index, delay * sampleRate);
    state.buffer[state.index] = this.sanitizeSample(sample, 4);
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

  createBaseLinkParams(link) {
    const panGains = this.panGains(link.pan);
    return {
      amount: link.amount,
      delay: link.delay,
      noise: link.noise,
      pan: link.pan,
      panGains,
      filter: link.filter,
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
        this.applyEnvelopeTrigger(modLink, link, voice, now, modulation.signal);
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
      cutoff: this.clamp(params.filter.cutoff * Math.pow(2, this.clamp(cutoffMod, -5, 5)), 20, Math.min(12000, sampleRate * 0.45)),
      resonance: this.clamp(params.filter.resonance + resonanceMod, 0.1, 12),
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

  linkModulationSignal(link, voice, now, source, cache, stack, linkStack = new Set(), options = {}) {
    const params = this.effectiveLinkParams(link, voice, now, cache, stack, linkStack);
    const shapedSource = this.applyLinkFilter(link, voice, source, params.filter);
    const envelope = options.ignoreEnvelope ? 1 : this.envelopeValue(link, voice, now, params);
    const delayed = this.applyLinkDelay(
      link,
      voice,
      shapedSource * envelope * this.velocityScale(link, voice),
      params,
    );
    const signal = this.applyLinkNoise(delayed, params);
    return {
      signal,
      amount: params.amount,
      value: signal * params.amount,
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
    let phaseMod = 0;
    let frequencyMod = 0;
    let foldDrive = 0;
    let mixAmount = 0;
    let mixSignal = 0;
    const ringMods = [];
    const incoming = this.incoming.get(nodeId) || [];

    for (const link of incoming) {
      const source = link.from === nodeId
        ? this.feedbackSignal(voice, nodeId)
        : this.renderNode(link.from, voice, now, cache, stack, linkStack);
      const modulation = this.linkModulationSignal(link, voice, now, source, cache, stack, linkStack);
      if (link.modulationTarget === "frequency") {
        frequencyMod += modulation.value;
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
    const baseFrequency = this.baseFrequency(node, voice);
    const isActiveWave = PITCHED_WAVE_TYPES.has(node.wave) ? baseFrequency > 0 : true;
    let value = isActiveWave ? this.oscillator(node, phase + phaseMod, voice) : 0;
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
      const current = voice.phases.get(node.id) || 0;
      const next = current + (baseFrequency * frequencyMultiplier) / sampleRate;
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
      const envelope = this.envelopeValue(link, voice, now, params);
      const delayedSource = this.applyLinkDelay(link, voice, filteredSource * envelope * this.velocityScale(link, voice), params);
      const linkSample = this.applyLinkNoise(delayedSource, params) * params.amount;
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
    return true;
  }
}

registerProcessor("visual-fm-engine", VisualFmEngine);
