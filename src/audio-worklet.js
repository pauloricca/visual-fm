const TWO_PI = Math.PI * 2;

class VisualFmEngine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.nodes = [];
    this.links = [];
    this.incoming = new Map();
    this.outputLinks = [];
    this.voices = new Map();
    this.sampleCursor = 0;
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
        this.voices.clear();
      }
    };
  }

  setGraph(graph) {
    this.nodes = (graph.nodes || []).map((node) => this.normalizeNode(node));
    this.links = (graph.links || []).map((link) => ({
      ...link,
      modulationTarget: this.normalizeModulationTarget(link.modulationTarget, link.to),
      pan: this.clamp(Number(link.pan) || 0, -1, 1),
      filter: this.normalizeLinkFilter(link.filter),
    }));
    this.masterEffects = this.normalizeEffects(graph.masterEffects);
    this.incoming = new Map();
    this.outputLinks = [];

    for (const link of this.links) {
      if (link.to === "audio") {
        this.outputLinks.push(link);
      } else {
        const group = this.incoming.get(link.to) || [];
        group.push(link);
        this.incoming.set(link.to, group);
      }
    }

    for (const voice of this.voices.values()) {
      if (!voice.nodeFilters) voice.nodeFilters = new Map();
      if (!voice.frequencyMods) voice.frequencyMods = new Map();
      if (!voice.outputFilterMods) voice.outputFilterMods = new Map();
      for (const node of this.nodes) {
        if (!voice.phases.has(node.id)) {
          voice.phases.set(node.id, Math.random());
        }
        if (!voice.feedback.has(node.id)) {
          voice.feedback.set(node.id, { prev1: 0, prev2: 0 });
        }
      }
    }
  }

  normalizeNode(node = {}) {
    return {
      id: node.id,
      wave: ["sine", "triangle", "saw", "square", "noise"].includes(node.wave) ? node.wave : "sine",
      frequencyMode: node.frequencyMode === "fixed" ? "fixed" : "ratio",
      ratio: this.clamp(Number(node.ratio) || 1, 0.125, 16),
      frequency: this.clamp(Number(node.frequency) || 440, 0.01, Math.min(12000, sampleRate * 0.45)),
    };
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
    return {
      type,
      cutoff: this.clamp(Number(filter.cutoff) || 5000, 20, Math.min(12000, sampleRate * 0.45)),
      resonance: this.clamp(Number(filter.resonance) || 0.7, 0.1, 12),
    };
  }

  normalizeModulationTarget(target, to) {
    if (to === "audio") return "amplitude";
    return ["phase", "frequency", "filterCutoff", "amplitude"].includes(target) ? target : "phase";
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

  readDelay(buffer, writeIndex, delaySamples) {
    const length = buffer.length;
    let index = writeIndex - delaySamples;
    while (index < 0) index += length;

    const indexA = Math.floor(index) % length;
    const indexB = (indexA + 1) % length;
    const fraction = index - Math.floor(index);
    return buffer[indexA] * (1 - fraction) + buffer[indexB] * fraction;
  }

  applyChorus(sample, channel) {
    const effect = this.masterEffects.chorus;
    const buffer = this.chorusBuffers[channel];
    const index = this.chorusIndices[channel];
    if (!effect.enabled || effect.mix <= 0) {
      buffer[index] = sample;
      this.chorusIndices[channel] = (index + 1) % buffer.length;
      return sample;
    }

    const baseDelay = 0.012 * sampleRate;
    const depthSamples = effect.depth * sampleRate;
    const lfo = 0.5 + 0.5 * Math.sin(this.chorusPhases[channel]);
    const delayed = this.readDelay(buffer, index, baseDelay + depthSamples * lfo);
    buffer[index] = sample;
    this.chorusIndices[channel] = (index + 1) % buffer.length;
    this.chorusPhases[channel] = (this.chorusPhases[channel] + (TWO_PI * effect.rate) / sampleRate) % TWO_PI;
    return sample * (1 - effect.mix) + delayed * effect.mix;
  }

  applyDelay(sample, channel) {
    const effect = this.masterEffects.delay;
    const buffer = this.delayBuffers[channel];
    const index = this.delayIndices[channel];
    const delaySamples = Math.min(buffer.length - 1, Math.max(1, effect.time * sampleRate));
    const delayed = this.readDelay(buffer, index, delaySamples);
    buffer[index] = sample + delayed * (effect.enabled ? effect.feedback : 0);
    this.delayIndices[channel] = (index + 1) % buffer.length;

    if (!effect.enabled || effect.mix <= 0) return sample;
    return sample * (1 - effect.mix) + delayed * effect.mix;
  }

  applyReverb(sample, channel) {
    const effect = this.masterEffects.reverb;
    let wet = 0;

    for (const delay of this.reverbDelays[channel]) {
      const readIndex = delay.index;
      const delayed = delay.buffer[readIndex];
      wet += delayed;
      const damping = effect.enabled ? effect.decay * (0.55 + effect.size * 0.4) : 0;
      delay.buffer[readIndex] = sample + delayed * damping;
      delay.index = (delay.index + 1) % delay.buffer.length;
    }

    wet *= 0.25;
    if (!effect.enabled || effect.mix <= 0) return sample;
    return sample * (1 - effect.mix) + wet * effect.mix;
  }

  applyMasterEffects(sample, channel) {
    let effected = sample;
    effected = this.applyChorus(effected, channel);
    effected = this.applyDelay(effected, channel);
    effected = this.applyReverb(effected, channel);
    return Math.tanh(effected);
  }

  noteOn(note, velocity = 1) {
    const voice = {
      note,
      frequency: 440 * Math.pow(2, (note - 69) / 12),
      velocity: Math.max(0.05, Math.min(1, velocity)),
      startedAt: this.sampleCursor / sampleRate,
      releasedAt: null,
      releaseLevels: new Map(),
      phases: new Map(),
      feedback: new Map(),
      linkFilters: new Map(),
      nodeFilters: new Map(),
      frequencyMods: new Map(),
      outputFilterMods: new Map(),
    };

    for (const node of this.nodes) {
      voice.phases.set(node.id, Math.random());
      voice.feedback.set(node.id, { prev1: 0, prev2: 0 });
    }

    this.voices.set(note, voice);
  }

  noteOff(note) {
    const voice = this.voices.get(note);
    if (!voice) return;
    voice.releasedAt = this.sampleCursor / sampleRate;
    voice.releaseLevels.clear();
  }

  velocityScale(link, voice) {
    const sensitivity = Math.max(0, Math.min(1, Number(link.velocitySensitivity) || 0));
    return 1 - sensitivity + sensitivity * voice.velocity;
  }

  attackCurve(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  decayCurve(t) {
    return Math.pow(1 - t, 2);
  }

  envelopeValue(link, voice, now) {
    const env = link.envelope || { delay: 0, attack: 0.01, decay: 0.16, sustain: 0.72, release: 0.24 };
    const delay = Math.max(0, env.delay || 0);
    const attack = Math.max(0.001, env.attack);
    const decay = Math.max(0.001, env.decay);
    const sustain = Math.max(0, Math.min(1, env.sustain));
    const release = Math.max(0.001, env.release);

    const heldValue = (time) => {
      let elapsed = Math.max(0, time - voice.startedAt);
      if (elapsed < delay) return 0;
      elapsed -= delay;
      if (elapsed < attack) return this.attackCurve(elapsed / attack);
      if (elapsed < attack + decay) {
        const t = (elapsed - attack) / decay;
        return sustain + (1 - sustain) * this.decayCurve(t);
      }
      return sustain;
    };

    if (voice.releasedAt === null) {
      return heldValue(now);
    }

    if (!voice.releaseLevels.has(link.id)) {
      voice.releaseLevels.set(link.id, heldValue(voice.releasedAt));
    }

    const t = Math.max(0, Math.min(1, (now - voice.releasedAt) / release));
    return Math.max(0, voice.releaseLevels.get(link.id) * this.decayCurve(t));
  }

  oscillator(node, phase) {
    const p = phase - Math.floor(phase);
    switch (node.wave) {
      case "triangle":
        return 1 - 4 * Math.abs(Math.round(p - 0.25) - (p - 0.25));
      case "saw":
        return 2 * p - 1;
      case "square":
        return p < 0.5 ? 1 : -1;
      case "noise":
        return Math.random() * 2 - 1;
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
    history.prev1 = value;
    voice.feedback.set(nodeId, history);
  }

  modulationAmount(link) {
    const amount = Number(link.amount) || 0;
    if (link.from === link.to) {
      return amount * 0.25;
    }
    return amount;
  }

  linkFilterState(voice, link) {
    const key = `${link.id}:${link.filter?.type || "none"}`;
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

  applyLinkFilter(link, voice, sample) {
    const filter = link.filter || { type: "none" };
    if (filter.type === "none") return sample;

    const state = this.linkFilterState(voice, link);
    const coefficients = this.filterCoefficients(filter);
    const output = coefficients.b0 * sample
      + coefficients.b1 * state.x1
      + coefficients.b2 * state.x2
      - coefficients.a1 * state.y1
      - coefficients.a2 * state.y2;

    state.x2 = state.x1;
    state.x1 = sample;
    state.y2 = state.y1;
    state.y1 = Number.isFinite(output) ? this.clamp(output, -4, 4) : 0;
    return state.y1;
  }

  applyOutputLinkFilter(link, voice, sample) {
    const filter = link.filter || { type: "none" };
    if (filter.type === "none") return sample;

    const cutoffMod = voice.outputFilterMods.get(link.from) || 0;
    const modulatedFilter = {
      ...filter,
      cutoff: Number(filter.cutoff || 5000) * Math.pow(2, this.clamp(cutoffMod, -5, 5)),
    };
    const state = this.linkFilterState(voice, link);
    const coefficients = this.filterCoefficients(modulatedFilter);
    const output = coefficients.b0 * sample
      + coefficients.b1 * state.x1
      + coefficients.b2 * state.x2
      - coefficients.a1 * state.y1
      - coefficients.a2 * state.y2;

    state.x2 = state.x1;
    state.x1 = sample;
    state.y2 = state.y1;
    state.y1 = Number.isFinite(output) ? this.clamp(output, -4, 4) : 0;
    return state.y1;
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
    state.x1 = sample;
    state.y2 = state.y1;
    state.y1 = Number.isFinite(output) ? this.clamp(output, -4, 4) : 0;
    return state.y1;
  }

  linkModulationValue(link, voice, now, source) {
    const shapedSource = this.applyLinkFilter(link, voice, source);
    return shapedSource * this.modulationAmount(link) * this.envelopeValue(link, voice, now) * this.velocityScale(link, voice);
  }

  panGains(pan) {
    const angle = (this.clamp(Number(pan) || 0, -1, 1) + 1) * Math.PI * 0.25;
    return {
      left: Math.cos(angle),
      right: Math.sin(angle),
    };
  }

  renderNode(nodeId, voice, now, cache, stack) {
    if (cache.has(nodeId)) return cache.get(nodeId);
    if (stack.has(nodeId)) return 0;

    const node = this.nodes.find((item) => item.id === nodeId);
    if (!node) return 0;

    stack.add(nodeId);
    let phaseMod = 0;
    let frequencyMod = 0;
    let filterCutoffMod = 0;
    let amplitudeMod = 0;
    const incoming = this.incoming.get(nodeId) || [];

    for (const link of incoming) {
      const source = link.from === nodeId
        ? this.feedbackSignal(voice, nodeId)
        : this.renderNode(link.from, voice, now, cache, stack);
      const modulation = this.linkModulationValue(link, voice, now, source);
      if (link.modulationTarget === "frequency") {
        frequencyMod += modulation;
      } else if (link.modulationTarget === "filterCutoff") {
        filterCutoffMod += modulation;
      } else if (link.modulationTarget === "amplitude") {
        amplitudeMod += modulation;
      } else {
        phaseMod += modulation;
      }
    }

    if (!voice.phases.has(nodeId)) {
      voice.phases.set(nodeId, Math.random());
    }

    const phase = voice.phases.get(nodeId);
    const amplitude = this.clamp(1 + amplitudeMod, 0, 2.5);
    const value = this.oscillator(node, phase + phaseMod) * amplitude;
    voice.frequencyMods.set(nodeId, frequencyMod);
    voice.outputFilterMods.set(nodeId, filterCutoffMod);
    cache.set(nodeId, value);
    this.storeFeedback(voice, nodeId, value);
    stack.delete(nodeId);
    return value;
  }

  advancePhases(voice) {
    for (const node of this.nodes) {
      if (node.wave === "noise") continue;
      const baseFrequency = node.frequencyMode === "fixed"
        ? node.frequency
        : voice.frequency * (Number.isFinite(node.ratio) ? node.ratio : 1);
      const frequencyMod = this.clamp(voice.frequencyMods.get(node.id) || 0, -5, 5);
      const frequencyMultiplier = Math.pow(2, frequencyMod);
      const current = voice.phases.get(node.id) || 0;
      voice.phases.set(node.id, current + (baseFrequency * frequencyMultiplier) / sampleRate);
    }
  }

  pruneVoices(now) {
    let longestRelease = 0.05;
    for (const link of this.links) {
      longestRelease = Math.max(longestRelease, link.envelope?.release || 0.05);
    }
    for (const [note, voice] of this.voices) {
      if (voice.releasedAt !== null && now - voice.releasedAt > longestRelease + 0.08) {
        this.voices.delete(note);
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];

    for (let i = 0; i < left.length; i += 1) {
      const now = this.sampleCursor / sampleRate;
      let leftSample = 0;
      let rightSample = 0;

      for (const voice of this.voices.values()) {
        const cache = new Map();
        let voiceLeft = 0;
        let voiceRight = 0;
        voice.frequencyMods.clear();
        voice.outputFilterMods.clear();

        for (const link of this.outputLinks) {
          const source = this.renderNode(link.from, voice, now, cache, new Set());
          const filteredSource = this.applyOutputLinkFilter(link, voice, source);
          const envelope = this.envelopeValue(link, voice, now);
          const linkSample = filteredSource * link.amount * envelope * this.velocityScale(link, voice);
          const pan = this.panGains(link.pan);
          voiceLeft += linkSample * pan.left;
          voiceRight += linkSample * pan.right;
        }

        leftSample += Math.tanh(voiceLeft);
        rightSample += Math.tanh(voiceRight);
        this.advancePhases(voice);
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
