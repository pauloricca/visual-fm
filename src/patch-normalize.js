import {
  DEFAULT_NODE_QUANTISE,
  DEFAULT_LINK_FILTER,
  DEFAULT_LINK_DISTORTION,
  DEFAULT_LINK_FOLLOWER,
  DEFAULT_AUDIO_DEVICE_ID,
  DEFAULT_CUSTOM_WAVE,
  DEFAULT_KEYBOARD_LENGTH,
  DEFAULT_KEYBOARD_START_NOTE,
  DEFAULT_MAX_VOICES,
  FREQUENCY_MODES,
  LINK_FILTER_TYPES,
  LINK_DISTORTION_TYPES,
  LINK_MIDI_PARAMETERS,
  LINK_MODULATION_TARGETS,
  LINK_SIGNAL_MODES,
  MASTER_EFFECT_IDS,
  MASTER_EFFECTS,
  MAX_MAX_VOICES,
  MAX_KEYBOARD_LENGTH,
  MAX_KEYBOARD_START_NOTE,
  MIDI_CC_CURVES,
  MIN_KEYBOARD_LENGTH,
  MIN_KEYBOARD_START_NOTE,
  MIN_MAX_VOICES,
  NODE_MIDI_PARAMETERS,
  NODE_MODULATION_TARGETS,
  OSCILLATOR_WAVE_TYPES,
  QUANTISE_ROOT_NOTES,
  QUANTISE_SCALES,
  VELOCITY_SENSITIVITY_MAX,
  VELOCITY_SENSITIVITY_MIN,
  WAVE_TYPES,
  defaultPatch,
} from "./constants.js";
import { alphaName, clamp, clonePatch } from "./utils.js";

const SAFE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function normalizePatch(patch) {
  const source = patch && Array.isArray(patch.nodes) && Array.isArray(patch.links) ? patch : defaultPatch;
  const patchName = typeof source.patchName === "string" && source.patchName.trim()
    ? source.patchName.trim()
    : "Visual FM Patch";
  const maxVoices = Number.isFinite(Number(source.maxVoices))
    ? clamp(Math.round(Number(source.maxVoices)), MIN_MAX_VOICES, MAX_MAX_VOICES)
    : DEFAULT_MAX_VOICES;
  const sourceMidiChannel = String(source.midiChannel || "all");
  const midiChannel = sourceMidiChannel === "all" || (Number(sourceMidiChannel) >= 1 && Number(sourceMidiChannel) <= 16)
    ? sourceMidiChannel
    : "all";
  const midiInputId = typeof source.midiInputId === "string" && source.midiInputId.trim()
    ? source.midiInputId
    : "all";
  const keyboardStartNote = Number.isFinite(Number(source.keyboardStartNote))
    ? clamp(Math.round(Number(source.keyboardStartNote)), MIN_KEYBOARD_START_NOTE, MAX_KEYBOARD_START_NOTE)
    : DEFAULT_KEYBOARD_START_NOTE;
  const keyboardLength = Number.isFinite(Number(source.keyboardLength))
    ? clamp(Math.round(Number(source.keyboardLength)), MIN_KEYBOARD_LENGTH, MAX_KEYBOARD_LENGTH)
    : DEFAULT_KEYBOARD_LENGTH;
  const audioInputDeviceId = normalizeAudioDeviceId(source.audioInputDeviceId);
  const audioOutputDeviceId = normalizeAudioDeviceId(source.audioOutputDeviceId);
  const audioOutPosition = normalizePoint(source.audioOutPosition);
  const linkSignalGradientMeters = Boolean(source.linkSignalGradientMeters);
  const nodeIdMap = new Map();
  const linkIdMap = new Map();
  const nodes = source.nodes.map((node, index) => {
    const sourceId = sourceEntityId(node.id, "op", index);
    const id = uniqueSafeId(sourceId, "op", index, nodeIdMap);
    if (!nodeIdMap.has(sourceId)) nodeIdMap.set(sourceId, id);
    return {
      id,
      name: typeof node.name === "string" && node.name.trim() ? node.name : alphaName(index),
      x: Number.isFinite(node.x) ? node.x : 220 + index * 210,
      y: Number.isFinite(node.y) ? node.y : 220,
      wave: WAVE_TYPES.includes(node.wave) ? node.wave : "sine",
      frequencyMode: normalizeFrequencyMode(node.frequencyMode),
      ratio: Number.isFinite(Number(node.ratio)) ? clamp(Number(node.ratio), 0, 16) : 1,
      frequency: Number.isFinite(Number(node.frequency)) ? clamp(Number(node.frequency), 0, 12000) : 440,
      frequencySlow: Boolean(node.frequencySlow),
      quantise: normalizeNodeQuantise(node.quantise),
      speed: Number.isFinite(Number(node.speed)) ? clamp(Number(node.speed), 0.01, 60) : 8,
      audioInputGain: Number.isFinite(Number(node.audioInputGain)) ? clamp(Number(node.audioInputGain), 0, 4) : 1,
      customWave: normalizeCustomWave(node.customWave),
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const sourceLinksById = new Map();
  const linkIdsByIndex = source.links.map((link, index) => {
    const sourceId = sourceEntityId(link.id, "link", index);
    if (!sourceLinksById.has(sourceId)) sourceLinksById.set(sourceId, link);
    const id = uniqueSafeId(sourceId, "link", index, linkIdMap);
    if (!linkIdMap.has(sourceId)) linkIdMap.set(sourceId, id);
    return id;
  });
  const sourceLinkIds = new Set(linkIdMap.keys());
  let links = source.links
    .filter((link, index) => {
      const sourceId = sourceEntityId(link.id, "link", index);
      const from = nodeIdMap.get(link.from);
      const to = normalizedLinkTarget(link.to, nodeIdMap, linkIdMap);
      return nodeIds.has(from)
        && (nodeIds.has(to) || to === "audio" || (sourceLinkIds.has(link.to) && link.to !== sourceId));
    })
    .map((link, index) => {
      const to = normalizedLinkTarget(link.to, nodeIdMap, linkIdMap);
      return {
        id: linkIdsByIndex[index],
        from: nodeIdMap.get(link.from),
        to,
        amount: Number.isFinite(Number(link.amount)) ? Number(link.amount) : 0,
        delay: Number.isFinite(Number(link.delay)) ? clamp(Number(link.delay), 0, 3) : 0,
        noise: Number.isFinite(Number(link.noise)) ? clamp(Number(link.noise), 0, 1) : 0,
        pan: Number.isFinite(Number(link.pan)) ? clamp(Number(link.pan), -1, 1) : 0,
        velocitySensitivity: Number.isFinite(Number(link.velocitySensitivity))
          ? clamp(Number(link.velocitySensitivity), VELOCITY_SENSITIVITY_MIN, VELOCITY_SENSITIVITY_MAX)
          : link.to === "audio" ? 1 : 0,
        modulationTarget: normalizeModulationTarget(
          link.modulationTarget,
          to,
          sourceLinkIds.has(link.to) ? sourceLinksById.get(link.to) : null,
          nodesById.get(to),
        ),
        drone: Boolean(link.drone),
        signalMode: normalizeSignalMode(link.signalMode),
        follower: normalizeFollower(link.follower),
        filter: normalizeLinkFilter(link.filter),
        distortion: normalizeLinkDistortion(link.distortion),
        envelope: normalizeEnvelope(link.envelope),
      };
    });
  let linksChanged = true;
  while (linksChanged) {
    const linkIds = new Set(links.map((link) => link.id));
    const nextLinks = links.filter((link) => (
      nodeIds.has(link.from)
        && (nodeIds.has(link.to) || link.to === "audio" || (linkIds.has(link.to) && link.to !== link.id))
    ));
    linksChanged = nextLinks.length !== links.length;
    links = nextLinks;
  }

  return {
    patchName,
    maxVoices,
    audioInputDeviceId,
    audioOutputDeviceId,
    audioOutPosition,
    linkSignalGradientMeters,
    midiChannel,
    midiInputId,
    keyboardStartNote,
    keyboardLength,
    midiBindings: normalizeMidiBindings(source.midiBindings, nodes, links, nodeIdMap, linkIdMap),
    masterEffects: normalizeMasterEffects(source.masterEffects),
    nodes,
    links,
  };
}

function normalizeAudioDeviceId(deviceId) {
  return typeof deviceId === "string" && deviceId.trim()
    ? deviceId
    : DEFAULT_AUDIO_DEVICE_ID;
}

function normalizePoint(point) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null;
  return {
    x: Number(point.x),
    y: Number(point.y),
  };
}

export function normalizeDefaultPatch() {
  return normalizePatch(clonePatch(defaultPatch));
}

export function normalizeLinkFilter(filter = {}) {
  const type = LINK_FILTER_TYPES.includes(filter.type) ? filter.type : DEFAULT_LINK_FILTER.type;
  const isFormant = type === "formant";
  const isComb = type === "comb" || type === "comb-notch";
  return {
    type,
    cutoff: Number.isFinite(Number(filter.cutoff))
      ? clamp(Number(filter.cutoff), isFormant ? 0 : 20, isFormant ? 1 : isComb ? 5000 : 12000)
      : isFormant ? 0 : isComb ? 440 : DEFAULT_LINK_FILTER.cutoff,
    resonance: Number.isFinite(Number(filter.resonance))
      ? clamp(Number(filter.resonance), isComb ? -0.98 : 0.1, isFormant ? 36 : isComb ? 0.98 : 12)
      : isComb ? 0.45 : DEFAULT_LINK_FILTER.resonance,
  };
}

export function normalizeLinkDistortion(distortion = {}) {
  return {
    enabled: Boolean(distortion.enabled),
    type: LINK_DISTORTION_TYPES.includes(distortion.type)
      ? distortion.type
      : DEFAULT_LINK_DISTORTION.type,
    gain: Number.isFinite(Number(distortion.gain))
      ? clamp(Number(distortion.gain), 0.1, 40)
      : DEFAULT_LINK_DISTORTION.gain,
  };
}

export function normalizeModulationTarget(target, to, targetLink = null, targetNode = null) {
  if (to === "audio") return "amplitude";
  if (targetLink) {
    const targets = linkHasPan(targetLink)
      ? LINK_MODULATION_TARGETS
      : LINK_MODULATION_TARGETS.filter((item) => item !== "pan");
    return targets.includes(target) ? target : "amplitude";
  }
  const targets = targetNode && OSCILLATOR_WAVE_TYPES.includes(targetNode.wave)
    ? NODE_MODULATION_TARGETS
    : NODE_MODULATION_TARGETS.filter((item) => item !== "wave");
  return targets.includes(target) ? target : "phase";
}

export function normalizeFrequencyMode(mode) {
  return FREQUENCY_MODES.includes(mode) ? mode : "ratio";
}

export function normalizeNodeQuantise(quantise = {}) {
  return {
    enabled: Boolean(quantise.enabled),
    root: QUANTISE_ROOT_NOTES.includes(quantise.root) ? quantise.root : DEFAULT_NODE_QUANTISE.root,
    scale: QUANTISE_SCALES.includes(quantise.scale) ? quantise.scale : DEFAULT_NODE_QUANTISE.scale,
    glide: Number.isFinite(Number(quantise.glide)) ? clamp(Number(quantise.glide), 0, 4) : DEFAULT_NODE_QUANTISE.glide,
  };
}

export function normalizeSignalMode(mode) {
  return LINK_SIGNAL_MODES.includes(mode) ? mode : "raw";
}

export function normalizeCustomWave(customWave = {}) {
  const customWaveModes = new Set(["loop", "once", "ping-pong", "sustain", "sustain-loop", "sustain-ping-pong"]);
  const sourceMode = customWave.mode || customWave.playback;
  const mode = customWaveModes.has(sourceMode) ? sourceMode : DEFAULT_CUSTOM_WAVE.mode;
  const sustainStart = Number.isFinite(Number(customWave.sustainStart))
    ? clamp(Number(customWave.sustainStart), 0, 0.999)
    : DEFAULT_CUSTOM_WAVE.sustainStart;
  const sustainEnd = Number.isFinite(Number(customWave.sustainEnd))
    ? clamp(Number(customWave.sustainEnd), sustainStart + 0.001, 1)
    : Math.max(sustainStart + 0.001, DEFAULT_CUSTOM_WAVE.sustainEnd);
  const sourcePoints = Array.isArray(customWave.points) ? customWave.points : DEFAULT_CUSTOM_WAVE.points;
  const pointsByX = new Map();
  for (const point of sourcePoints) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pointsByX.set(clamp(x, 0, 1), clamp(y, -1, 1));
  }
  pointsByX.set(0, 0);
  pointsByX.set(1, 0);
  const points = [...pointsByX.entries()]
    .map(([x, y]) => ({ x, y }))
    .sort((a, b) => a.x - b.x);
  return {
    mode,
    sustainStart,
    sustainEnd,
    points,
  };
}

export function linkHasPan(link) {
  return link?.to === "audio";
}

function normalizeMasterEffects(effects = {}) {
  return {
    chorus: {
      enabled: Boolean(effects.chorus?.enabled),
      rate: clamp(Number(effects.chorus?.rate) || 0.8, 0.05, 6),
      depth: clamp(Number(effects.chorus?.depth) || 0.012, 0.001, 0.04),
      mix: clamp(Number(effects.chorus?.mix) || 0.25, 0, 1),
    },
    delay: {
      enabled: Boolean(effects.delay?.enabled),
      time: clamp(Number(effects.delay?.time) || 0.28, 0.02, 1.5),
      feedback: clamp(Number(effects.delay?.feedback) || 0.35, 0, 0.92),
      mix: clamp(Number(effects.delay?.mix) || 0.25, 0, 1),
    },
    reverb: {
      enabled: Boolean(effects.reverb?.enabled),
      size: clamp(Number(effects.reverb?.size) || 0.55, 0.1, 1),
      decay: clamp(Number(effects.reverb?.decay) || 0.45, 0, 0.94),
      mix: clamp(Number(effects.reverb?.mix) || 0.25, 0, 1),
    },
  };
}

function normalizeEnvelope(envelope = {}) {
  return {
    delay: Number.isFinite(Number(envelope.delay)) ? Number(envelope.delay) : 0,
    attack: Number.isFinite(Number(envelope.attack)) ? Number(envelope.attack) : 0.03,
    decay: Number.isFinite(Number(envelope.decay)) ? Number(envelope.decay) : 0.16,
    sustain: Number.isFinite(Number(envelope.sustain)) ? Number(envelope.sustain) : 0.65,
    release: Number.isFinite(Number(envelope.release)) ? Number(envelope.release) : 0.26,
  };
}

function normalizeFollower(follower = {}) {
  return {
    attack: Number.isFinite(Number(follower.attack))
      ? clamp(Number(follower.attack), 0.001, 2)
      : DEFAULT_LINK_FOLLOWER.attack,
    release: Number.isFinite(Number(follower.release))
      ? clamp(Number(follower.release), 0.001, 4)
      : DEFAULT_LINK_FOLLOWER.release,
  };
}

function normalizeMidiBindings(bindings, nodes, links, nodeIdMap, linkIdMap) {
  if (!Array.isArray(bindings)) return [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const linkIds = new Set(links.map((link) => link.id));
  const targetTypes = new Set(["node", "link", "effect"]);
  const bindingIds = new Set();
  return bindings
    .map((binding, index) => {
      const targetType = targetTypes.has(binding.targetType) ? binding.targetType : "node";
      const targetId = normalizeBindingTargetId(binding.targetId, targetType, nodeIdMap, linkIdMap);
      const parameter = typeof binding.parameter === "string" ? binding.parameter : "";
      const cc = Number(binding.cc);
      const normalized = {
        id: uniqueSafeBindingId(binding.id, index, bindingIds),
        targetType,
        targetId,
        parameter,
        cc: Number.isFinite(cc) ? clamp(Math.round(cc), 0, 127) : 0,
      };
      if (Number.isFinite(Number(binding.min))) normalized.min = Number(binding.min);
      if (Number.isFinite(Number(binding.max))) normalized.max = Number(binding.max);
      if (MIDI_CC_CURVES.includes(binding.curve)) normalized.curve = binding.curve;
      return normalized;
    })
    .filter((binding) => {
      if (binding.targetType === "node") {
        return nodeIds.has(binding.targetId) && NODE_MIDI_PARAMETERS.has(binding.parameter);
      }
      if (binding.targetType === "link") {
        return linkIds.has(binding.targetId) && LINK_MIDI_PARAMETERS.has(binding.parameter);
      }
      return MASTER_EFFECT_IDS.includes(binding.targetId)
        && hasEffectMidiParameter(binding.targetId, binding.parameter);
    });
}

function normalizeBindingTargetId(targetId, targetType, nodeIdMap, linkIdMap) {
  if (targetType === "node") return nodeIdMap.get(targetId) || "";
  if (targetType === "link") return linkIdMap.get(targetId) || "";
  return typeof targetId === "string" ? targetId : "";
}

function hasEffectMidiParameter(effectId, parameter) {
  return parameter === "enabled"
    || (MASTER_EFFECTS[effectId]?.params || []).some(([key]) => key === parameter);
}

function sourceEntityId(id, prefix, index) {
  return typeof id === "string" && id.trim() ? id : `${prefix}-${index + 1}`;
}

function uniqueSafeId(sourceId, prefix, index, existingMap) {
  const usedIds = new Set(existingMap.values());
  let candidate = SAFE_ID_PATTERN.test(sourceId) ? sourceId : `${prefix}-${index + 1}`;
  if (usedIds.has(candidate)) candidate = `${prefix}-${index + 1}`;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${prefix}-${index + 1}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function uniqueSafeBindingId(id, index, usedIds) {
  let candidate = typeof id === "string" && SAFE_ID_PATTERN.test(id)
    ? id
    : `midi-binding-${index + 1}`;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `midi-binding-${index + 1}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizedLinkTarget(to, nodeIdMap, linkIdMap) {
  if (to === "audio") return "audio";
  return nodeIdMap.get(to) || linkIdMap.get(to) || "";
}
