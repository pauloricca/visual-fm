import {
  DEFAULT_LINK_FILTER,
  FREQUENCY_MODES,
  LINK_FILTER_TYPES,
  LINK_INPUT_T,
  LINK_MODULATION_TARGETS,
  MASTER_EFFECTS,
  MASTER_EFFECT_IDS,
  MAX_MAX_VOICES,
  MIDI_CC_CURVES,
  MIDI_CC_MAX_SMOOTH_DT,
  MIDI_CC_SETTLE_RATIO,
  MIDI_CC_SMOOTH_SECONDS,
  MIN_MAX_VOICES,
  NODE_MODULATION_TARGETS,
  RECENT_MIDI_CC_WINDOW_MS,
  STORAGE_KEY,
  VELOCITY_SENSITIVITY_MAX,
  VELOCITY_SENSITIVITY_MIN,
  WAVE_TYPES,
  keyMap,
} from "./constants.js";
import { downloadPatchFile, parsePatchFile } from "./patch-format.js";
import {
  linkHasPan,
  normalizeDefaultPatch,
  normalizeFrequencyMode,
  normalizePatch,
} from "./patch-normalize.js";
import { audioBufferToWav, mediaRecorderOptions } from "./recording.js";
import {
  alphaName,
  clamp,
  clonePatch,
  downloadBlob,
  escapeHtml,
  isPitchedWave,
  isSpeedWave,
  slugifyPatchName,
  timestampForFile,
} from "./utils.js";

const stage = document.querySelector("#stage");
const nodeLayer = document.querySelector("#nodeLayer");
const wireLayer = document.querySelector("#wireLayer");
const panel = document.querySelector("#panel");
const addNodeButton = document.querySelector("#addNodeButton");
const recordButton = document.querySelector("#recordButton");
const audioOut = document.querySelector("#audioOut");
const audioStatus = document.querySelector("#audioStatus");
const midiStatus = document.querySelector("#midiStatus");
const selectionRect = document.querySelector("#selectionRect");
const fineSliderButton = document.querySelector("#fineSliderButton");
const AUDIO_WORKLET_MODULE_URL = "./src/audio-worklet.js?v=envelope-retrigger-continuity-1";
const LINK_PARAM_GRAPH_SYNC_DELAY_MS = 180;
const FINE_SLIDER_SCALE = 0.1;

const state = {
  ...loadPatch(),
  selected: { type: "node", id: "op-1" },
};

let audioContext = null;
let synthNode = null;
let outputGainNode = null;
let audioInputStream = null;
let audioInputSource = null;
let recorderDestination = null;
let audioReadyPromise = null;
let mediaRecorder = null;
let recordingChunks = [];
let recordingStartedAt = null;
let recordingStarting = false;
let audioMuted = false;
let nodeCounter = 3;
let linkCounter = 3;
let midiBindingCounter = 1;
let dragState = null;
let linkDrag = null;
let marqueeState = null;
let pressedKeys = new Set();
let midiAccess = null;
let pendingPatchSave = null;
let pendingGraphFrame = null;
let pendingLinkParamGraphSync = null;
let pendingNodesAndWiresFrame = null;
let pendingWiresFrame = null;
let pendingMidiCcLearn = null;
let pendingMidiCcSmoothingFrame = null;
const midiCcSmoothing = new Map();
const recentMidiCc = new Map();
const recentMidiCcListeners = new Set();
const midiBindingFlashTimers = new Map();
const midiTargetFlashTimers = new Map();
let suppressNextStageClick = false;
let touchFineSliderPointerId = null;
let keyboardFineSliderActive = false;

syncCounters();
pruneMidiBindings();
if (!nodeById(state.selected.id) && state.nodes[0]) {
  state.selected = { type: "node", id: state.nodes[0].id };
}

function uid(prefix) {
  const next = prefix === "op" ? nodeCounter++ : linkCounter++;
  return `${prefix}-${next}`;
}

function midiBindingUid() {
  return `midi-binding-${midiBindingCounter++}`;
}

function nodeName(node) {
  return node?.name?.trim() || node?.id?.replace("op-", "Operator ") || "Operator";
}

function linkTargetKind(link) {
  if (!link) return "none";
  if (link.to === "audio") return "audio";
  return linkById(link.to) ? "link" : "node";
}

function targetName(to, seen = new Set()) {
  if (to === "audio") return "Audio Out";
  const targetLink = linkById(to);
  if (targetLink) return linkName(targetLink, seen);
  return nodeName(nodeById(to));
}

function linkName(link, seen = new Set()) {
  if (!link) return "Link";
  if (seen.has(link.id)) return "Link";
  seen.add(link.id);
  const name = `${nodeName(nodeById(link.from))} -> ${targetName(link.to, seen)}`;
  seen.delete(link.id);
  return name;
}

function patchUsesAudioInput() {
  return state.nodes.some((node) => node.wave === "audio-input");
}

function loadPatch() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizePatch(JSON.parse(saved)) : normalizeDefaultPatch();
  } catch {
    return normalizeDefaultPatch();
  }
}

function savePatch() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPatchData()));
  } catch {
    // Storage can fail in private browsing or restricted contexts; the synth should keep running.
  }
}

function currentPatchData() {
  return {
    patchName: state.patchName,
    maxVoices: state.maxVoices,
    midiChannel: state.midiChannel,
    midiInputId: state.midiInputId,
    midiBindings: state.midiBindings,
    masterEffects: state.masterEffects,
    nodes: state.nodes,
    links: state.links,
  };
}

function syncCounters() {
  const maxNodeId = state.nodes.reduce((max, node) => {
    const match = /^op-(\d+)$/.exec(node.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const maxLinkId = state.links.reduce((max, link) => {
    const match = /^link-(\d+)$/.exec(link.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const maxMidiBindingId = state.midiBindings.reduce((max, binding) => {
    const match = /^midi-binding-(\d+)$/.exec(binding.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  nodeCounter = maxNodeId + 1;
  linkCounter = maxLinkId + 1;
  midiBindingCounter = maxMidiBindingId + 1;
}

function nodeById(id) {
  return state.nodes.find((node) => node.id === id);
}

function linkById(id) {
  return state.links.find((link) => link.id === id);
}

function nodeParameterDefinitions(node) {
  const definitions = [
    {
      id: "wave",
      label: "Wave type",
      type: "choice",
      options: WAVE_TYPES.map((value) => ({ value, label: waveTypeLabel(value) })),
      get: () => node.wave,
      set: (value) => {
        node.wave = value;
        if (node.wave === "audio-input") {
          ensureAudio().catch(() => {
            setAudioStatusLabel("Audio input blocked");
          });
        } else {
          reconcileAudioInput();
        }
      },
    },
    ...(isPitchedWave(node.wave) ? [{
      id: "frequencyMode",
      label: "Tuning",
      type: "choice",
      options: FREQUENCY_MODES.map((value) => ({
        value,
        label: value === "fixed" ? "Fixed" : "Ratio",
      })),
      get: () => node.frequencyMode,
      set: (value) => {
        node.frequencyMode = normalizeFrequencyMode(value);
      },
    },
    {
      id: "ratio",
      label: "Ratio",
      type: "number",
      min: 0,
      max: 16,
      get: () => node.ratio,
      set: (value) => {
        node.ratio = value;
      },
    },
    {
      id: "frequency",
      label: "Frequency",
      type: "number",
      min: 0,
      max: 12000,
      get: () => node.frequency,
      set: (value) => {
        node.frequency = value;
      },
    }] : []),
    ...(isSpeedWave(node.wave) ? [{
      id: "speed",
      label: "Speed",
      type: "number",
      min: 0.01,
      max: 60,
      get: () => node.speed,
      set: (value) => {
        node.speed = value;
      },
    }] : []),
  ];

  return definitions;
}

function linkParameterDefinitions(link) {
  const targetNameLabel = targetName(link.to);
  const modulationTargets = modulationTargetsForLink(link);
  const amountMax = link.modulationTarget === "mix" ? 1 : 8;
  const definitions = [
    ...(modulationTargets.length ? [{
      id: "modulationTarget",
      label: "Modulates",
      type: "choice",
      options: modulationTargets.map((value) => ({
        value,
        label: modulationTargetLabel(value, targetNameLabel),
      })),
      get: () => link.modulationTarget,
      set: (value) => {
        link.modulationTarget = value;
        if (value === "mix") link.amount = clamp(link.amount, 0, 1);
      },
    }] : []),
    {
      id: "amount",
      label: "Amplitude",
      type: "number",
      min: 0,
      max: amountMax,
      get: () => link.amount,
      set: (value) => {
        link.amount = value;
      },
    },
    ...(linkHasPan(link) ? [{
      id: "pan",
      label: "Pan",
      type: "number",
      min: -1,
      max: 1,
      get: () => link.pan,
      set: (value) => {
        link.pan = value;
      },
    }] : []),
    {
      id: "velocitySensitivity",
      label: "Velocity sensitivity",
      type: "number",
      min: VELOCITY_SENSITIVITY_MIN,
      max: VELOCITY_SENSITIVITY_MAX,
      get: () => link.velocitySensitivity,
      set: (value) => {
        link.velocitySensitivity = value;
      },
    },
    {
      id: "noise",
      label: "Noise",
      type: "number",
      min: 0,
      max: 1,
      get: () => link.noise,
      set: (value) => {
        link.noise = value;
      },
    },
    {
      id: "delay",
      label: "Delay buffer",
      type: "number",
      min: 0,
      max: 3,
      get: () => link.delay,
      set: (value) => {
        link.delay = value;
      },
    },
    {
      id: "drone",
      label: "Drone",
      type: "boolean",
      get: () => link.drone,
      set: (value) => {
        link.drone = value;
        if (value) ensureAudio();
      },
    },
    {
      id: "filter.type",
      label: "Filter type",
      type: "choice",
      options: LINK_FILTER_TYPES.map((value) => ({ value, label: filterTypeLabel(value) })),
      get: () => link.filter.type,
      set: (value) => {
        link.filter.type = value;
      },
    },
    {
      id: "filter.cutoff",
      label: "Filter cutoff",
      type: "number",
      min: 20,
      max: 12000,
      get: () => link.filter.cutoff,
      set: (value) => {
        link.filter.cutoff = value;
      },
    },
    {
      id: "filter.resonance",
      label: "Filter resonance",
      type: "number",
      min: 0.1,
      max: 12,
      get: () => link.filter.resonance,
      set: (value) => {
        link.filter.resonance = value;
      },
    },
    ...[
      ["envelope.delay", "Envelope delay", 0, 4],
      ["envelope.attack", "Attack", 0.001, 4],
      ["envelope.decay", "Decay", 0.001, 4],
      ["envelope.sustain", "Sustain", 0, 1],
      ["envelope.release", "Release", 0.001, 6],
    ].map(([id, label, min, max]) => {
      const key = id.split(".")[1];
      return {
        id,
        label,
        type: "number",
        min,
        max,
        get: () => link.envelope[key],
        set: (value) => {
          link.envelope[key] = value;
        },
      };
    }),
  ];

  return definitions;
}

function effectLabel(effectId) {
  return MASTER_EFFECTS[effectId]?.label || effectId;
}

function effectParameterSpecs(effectId) {
  return MASTER_EFFECTS[effectId]?.params || [];
}

function hasEffectMidiParameter(effectId, parameter) {
  return parameter === "enabled"
    || effectParameterSpecs(effectId).some(([key]) => key === parameter);
}

function effectParameterDefinitions(effectId) {
  const effect = state.masterEffects[effectId];
  if (!effect) return [];

  return [
    {
      id: "enabled",
      label: "Enabled",
      type: "boolean",
      get: () => effect.enabled,
      set: (value) => {
        effect.enabled = value;
      },
    },
    ...effectParameterSpecs(effectId).map(([id, label, min, max, unit]) => ({
      id,
      label: unit ? `${label} (${unit})` : label,
      type: "number",
      min,
      max,
      get: () => effect[id],
      set: (value) => {
        effect[id] = value;
      },
    })),
  ];
}

function midiParameterDefinitions(targetType, targetId) {
  if (targetType === "effect") {
    return effectParameterDefinitions(targetId);
  }

  if (targetType === "link") {
    const link = linkById(targetId);
    return link ? linkParameterDefinitions(link) : [];
  }

  const node = nodeById(targetId);
  return node ? nodeParameterDefinitions(node) : [];
}

function midiParameterDefinition(binding) {
  return midiParameterDefinitions(binding.targetType, binding.targetId)
    .find((definition) => definition.id === binding.parameter);
}

function midiElementLabel(targetType, targetId) {
  if (targetType === "effect") {
    return `Audio Out: ${effectLabel(targetId)}`;
  }

  if (targetType === "link") {
    return linkName(linkById(targetId));
  }

  return nodeName(nodeById(targetId));
}

function midiParameterLabel(binding) {
  return midiParameterDefinition(binding)?.label || binding.parameter;
}

function midiBindingTouchesSelection(binding) {
  return binding.targetType === "effect"
    ? state.selected.type === "audio"
    : state.selected.type === binding.targetType && state.selected.id === binding.targetId;
}

function midiBindingForParameter(targetType, targetId, parameter) {
  return state.midiBindings.find((binding) => (
    binding.targetType === targetType
      && binding.targetId === targetId
      && binding.parameter === parameter
  ));
}

function midiCcButton(targetType, targetId, parameter) {
  const binding = midiBindingForParameter(targetType, targetId, parameter);
  const title = binding ? `Edit CC ${binding.cc} binding` : "Bind MIDI CC";
  return `
    <button
      class="cc-button ${binding ? "bound" : ""}"
      type="button"
      title="${title}"
      aria-label="${title}"
      data-midi-target-type="${escapeHtml(targetType)}"
      data-midi-target-id="${escapeHtml(targetId)}"
      data-midi-parameter="${escapeHtml(parameter)}"
      ${binding ? `data-midi-binding-id="${escapeHtml(binding.id)}"` : ""}
    >CC</button>
  `;
}

function parameterLabel(forId, label, targetType, targetId, parameter) {
  return `
    <div class="field-label-row">
      <label for="${escapeHtml(forId)}">${label}</label>
      ${midiCcButton(targetType, targetId, parameter)}
    </div>
  `;
}

function attachParameterMidiButtons() {
  for (const button of panel.querySelectorAll("[data-midi-parameter]")) {
    button.addEventListener("click", () => {
      const preset = {
        targetType: button.dataset.midiTargetType,
        targetId: button.dataset.midiTargetId,
        parameter: button.dataset.midiParameter,
      };
      openMidiBindingModal(button.dataset.midiBindingId || null, preset);
    });
  }
}

function pruneMidiBindings() {
  const validTargetIds = {
    node: new Set(state.nodes.map((node) => node.id)),
    link: new Set(state.links.map((link) => link.id)),
    effect: new Set(MASTER_EFFECT_IDS),
  };
  const nextBindings = state.midiBindings.filter((binding) => (
    validTargetIds[binding.targetType]?.has(binding.targetId)
      && midiParameterDefinition(binding)
  ));
  const changed = nextBindings.length !== state.midiBindings.length;
  state.midiBindings = nextBindings;
  return changed;
}

function schedulePatchSave() {
  clearTimeout(pendingPatchSave);
  pendingPatchSave = setTimeout(() => {
    pendingPatchSave = null;
    savePatch();
  }, 180);
}

function midiBindingRange(binding, definition) {
  if (definition.type !== "number") return null;
  const min = Number.isFinite(Number(binding.min))
    ? clamp(Number(binding.min), definition.min, definition.max)
    : definition.min;
  const max = Number.isFinite(Number(binding.max))
    ? clamp(Number(binding.max), definition.min, definition.max)
    : definition.max;
  return { min, max };
}

function midiBindingCurveValue(binding, normal) {
  const curve = MIDI_CC_CURVES.includes(binding.curve) ? binding.curve : "linear";
  if (curve === "logarithmic") {
    return Math.log10(1 + normal * 9);
  }
  if (curve === "exponential") {
    return (Math.pow(10, normal) - 1) / 9;
  }
  return normal;
}

function valueFromCc(definition, value, binding) {
  const normal = clamp(Number(value) || 0, 0, 127) / 127;
  if (definition.type === "choice") {
    const index = clamp(Math.round(normal * (definition.options.length - 1)), 0, definition.options.length - 1);
    return definition.options[index].value;
  }
  if (definition.type === "boolean") {
    return normal >= 0.5;
  }
  const range = midiBindingRange(binding, definition);
  const curved = midiBindingCurveValue(binding, normal);
  return range.min + curved * (range.max - range.min);
}

function midiSmoothingKey(binding) {
  return `${binding.targetType}:${binding.targetId}:${binding.parameter}`;
}

function scheduleMidiCcSmoothing() {
  if (pendingMidiCcSmoothingFrame) return;
  pendingMidiCcSmoothingFrame = requestAnimationFrame(processMidiCcSmoothing);
}

function queueMidiCcSmoothing(binding, definition, targetValue) {
  const key = midiSmoothingKey(binding);
  const existing = midiCcSmoothing.get(key);
  const currentValue = Number(definition.get());
  const current = existing?.current ?? (Number.isFinite(currentValue) ? currentValue : targetValue);
  const now = performance.now();
  const range = midiBindingRange(binding, definition);

  midiCcSmoothing.set(key, {
    targetType: binding.targetType,
    targetId: binding.targetId,
    parameter: binding.parameter,
    target: clamp(Number(targetValue), definition.min, definition.max),
    current,
    span: Math.max(0.000001, Math.abs(range.max - range.min)),
    lastTime: existing?.lastTime ?? now,
  });
  scheduleMidiCcSmoothing();
}

function setPanelNumberPair(inputId, rangeId, value) {
  const input = panel.querySelector(`#${inputId}`);
  const range = panel.querySelector(`#${rangeId}`);
  if (input) input.value = String(value);
  if (range) range.value = String(value);
}

function updatePanelForMidiNumber(smoothing, value) {
  if (!midiBindingTouchesSelection(smoothing)) return;

  if (smoothing.targetType === "effect") {
    setPanelNumberPair(
      `${smoothing.targetId}-${smoothing.parameter}`,
      `${smoothing.targetId}-${smoothing.parameter}Range`,
      value,
    );
    return;
  }

  if (smoothing.targetType === "node") {
    const node = nodeById(smoothing.targetId);
    if (
      node
        && ((smoothing.parameter === "frequency" && node.frequencyMode === "fixed")
          || (smoothing.parameter === "ratio" && node.frequencyMode === "ratio"))
    ) {
      setPanelNumberPair("frequencyValue", "frequencyValueRange", value);
    }
    if (node && smoothing.parameter === "speed") {
      setPanelNumberPair("speed", "speedRange", value);
    }
    return;
  }

  const linkControlIds = {
    amount: "amount",
    pan: "pan",
    velocitySensitivity: "velocitySensitivity",
    noise: "noise",
    delay: "linkDelay",
    "filter.cutoff": "filterCutoff",
    "filter.resonance": "filterResonance",
    "envelope.delay": "delay",
    "envelope.attack": "attack",
    "envelope.decay": "decay",
    "envelope.sustain": "sustain",
    "envelope.release": "release",
  };
  const inputId = linkControlIds[smoothing.parameter];
  if (!inputId) return;

  setPanelNumberPair(inputId, `${inputId}Range`, value);
  if (smoothing.parameter.startsWith("envelope.")) {
    const link = linkById(smoothing.targetId);
    if (link) refreshAdsrView(link.envelope);
  }
}

function processMidiCcSmoothing(timestamp) {
  pendingMidiCcSmoothingFrame = null;
  let changed = false;
  let shouldRenderNodesWhenSettled = false;
  let shouldRenderPanelWhenSettled = false;

  for (const [key, smoothing] of midiCcSmoothing) {
    const definition = midiParameterDefinition(smoothing);
    if (!definition || definition.type !== "number") {
      midiCcSmoothing.delete(key);
      continue;
    }

    const span = smoothing.span || Math.max(0.000001, definition.max - definition.min);
    const dt = Math.min(MIDI_CC_MAX_SMOOTH_DT, Math.max(0.001, (timestamp - smoothing.lastTime) / 1000));
    const alpha = 1 - Math.exp(-dt / MIDI_CC_SMOOTH_SECONDS);
    const next = smoothing.current + (smoothing.target - smoothing.current) * alpha;
    const settled = Math.abs(smoothing.target - next) <= Math.max(0.000001, span * MIDI_CC_SETTLE_RATIO);
    const value = settled ? smoothing.target : next;

    smoothing.current = clamp(value, definition.min, definition.max);
    smoothing.lastTime = timestamp;
    definition.set(smoothing.current);
    updatePanelForMidiNumber(smoothing, smoothing.current);
    changed = true;

    if (settled) {
      midiCcSmoothing.delete(key);
      shouldRenderNodesWhenSettled = shouldRenderNodesWhenSettled || smoothing.targetType === "node";
      shouldRenderPanelWhenSettled = shouldRenderPanelWhenSettled || midiBindingTouchesSelection(smoothing);
    }
  }

  if (changed) {
    if (shouldRenderNodesWhenSettled) renderNodes();
    if (shouldRenderPanelWhenSettled) renderPanel();
    sendGraph({ immediate: true });
    schedulePatchSave();
  }

  if (midiCcSmoothing.size) {
    scheduleMidiCcSmoothing();
  }
}

function applyMidiCc(cc, value) {
  let immediateChanged = false;
  let shouldRenderNodes = false;
  let shouldRenderPanel = false;

  for (const binding of state.midiBindings) {
    if (binding.cc !== cc) continue;
    flashMidiBindingItem(binding.id);
    flashMidiCanvasTarget(binding);

    const definition = midiParameterDefinition(binding);
    if (!definition) continue;

    const nextValue = valueFromCc(definition, value, binding);
    if (definition.type === "number") {
      queueMidiCcSmoothing(binding, definition, nextValue);
      continue;
    }

    definition.set(nextValue);
    immediateChanged = true;
    shouldRenderNodes = shouldRenderNodes || binding.targetType === "node";
    shouldRenderPanel = shouldRenderPanel || midiBindingTouchesSelection(binding);
  }

  if (!immediateChanged) return;

  if (shouldRenderNodes) renderNodes();
  if (shouldRenderPanel) renderPanel();
  sendGraph();
  schedulePatchSave();
}

function capturePendingMidiCc(cc) {
  if (!pendingMidiCcLearn) return;

  const { input } = pendingMidiCcLearn;
  pendingMidiCcLearn = null;
  if (!input?.isConnected) return;

  input.value = String(clamp(Math.round(Number(cc)), 0, 127));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.select();
}

function recentMidiCcEntries(now = Date.now()) {
  return [...recentMidiCc.entries()]
    .map(([cc, item]) => ({ cc, value: item.value, timestamp: item.timestamp }))
    .filter((item) => now - item.timestamp <= RECENT_MIDI_CC_WINDOW_MS)
    .sort((a, b) => b.timestamp - a.timestamp || a.cc - b.cc);
}

function notifyRecentMidiCcListeners() {
  for (const listener of recentMidiCcListeners) listener();
}

function pruneRecentMidiCc(now = Date.now()) {
  let changed = false;
  for (const [cc, item] of recentMidiCc) {
    if (now - item.timestamp > RECENT_MIDI_CC_WINDOW_MS) {
      recentMidiCc.delete(cc);
      changed = true;
    }
  }
  if (changed) notifyRecentMidiCcListeners();
}

function recordRecentMidiCc(cc, value) {
  recentMidiCc.set(clamp(Math.round(Number(cc)), 0, 127), {
    value: clamp(Math.round(Number(value)), 0, 127),
    timestamp: Date.now(),
  });
  notifyRecentMidiCcListeners();
}

function selectedNodeIds() {
  if (state.selected.type === "node" && state.selected.id) return [state.selected.id];
  if (state.selected.type === "nodes") return state.selected.ids || [];
  return [];
}

function isNodeSelected(id) {
  return selectedNodeIds().includes(id);
}

function selectNodes(ids) {
  const uniqueIds = [...new Set(ids)].filter((id) => nodeById(id));
  if (uniqueIds.length === 0) {
    state.selected = { type: null, id: null };
  } else if (uniqueIds.length === 1) {
    state.selected = { type: "node", id: uniqueIds[0] };
  } else {
    state.selected = { type: "nodes", ids: uniqueIds };
  }
  render();
}

function addNodeToSelection(id) {
  selectNodes([...selectedNodeIds(), id]);
}

function removeNodeFromSelection(id) {
  selectNodes(selectedNodeIds().filter((selectedId) => selectedId !== id));
}

function duplicateNodes(ids) {
  const uniqueIds = [...new Set(ids)].filter((id) => nodeById(id));
  const idMap = new Map();
  const copies = uniqueIds.map((id) => {
    const source = nodeById(id);
    const copy = {
      ...clonePatch(source),
      id: uid("op"),
      name: `${nodeName(source)} copy`,
    };
    idMap.set(id, copy.id);
    return copy;
  });
  const linkIdMap = new Map();
  const carrierLinks = state.links
    .filter((link) => idMap.has(link.from) && (idMap.has(link.to) || link.to === "audio"));
  const links = carrierLinks.map((link) => {
    const copy = {
      ...clonePatch(link),
      id: uid("link"),
      from: idMap.get(link.from),
      to: link.to === "audio" ? "audio" : idMap.get(link.to),
    };
    linkIdMap.set(link.id, copy.id);
    return copy;
  });
  const linkTargetLinks = state.links
    .filter((link) => idMap.has(link.from) && linkIdMap.has(link.to))
    .map((link) => {
      const copy = {
        ...clonePatch(link),
        id: uid("link"),
        from: idMap.get(link.from),
        to: linkIdMap.get(link.to),
      };
      linkIdMap.set(link.id, copy.id);
      return copy;
    });

  state.nodes.push(...copies);
  state.links.push(...links, ...linkTargetLinks);
  selectNodes(copies.map((node) => node.id));
  sendGraph();
  savePatch();
  return { copies, idMap };
}

function stagePoint(clientX, clientY) {
  const rect = stage.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function nodeOutputPoint(id) {
  const node = nodeById(id);
  return { x: node.x, y: node.y + 43 };
}

function nodeInputPoint(id) {
  const node = nodeById(id);
  return { x: node.x, y: node.y - 43 };
}

function audioInputPoint() {
  const stageRect = stage.getBoundingClientRect();
  const rect = audioOut.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2 - stageRect.left,
    y: rect.top - stageRect.top,
  };
}

function bezierPath(from, to) {
  const distance = Math.max(90, Math.abs(to.y - from.y) * 0.7 + Math.abs(to.x - from.x) * 0.22);
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + distance}, ${to.x} ${to.y - distance}, ${to.x} ${to.y}`;
}

function bezierPoint(from, to, t = 0.5) {
  const distance = Math.max(90, Math.abs(to.y - from.y) * 0.7 + Math.abs(to.x - from.x) * 0.22);
  const p0 = from;
  const p1 = { x: from.x, y: from.y + distance };
  const p2 = { x: to.x, y: to.y - distance };
  const p3 = to;
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y,
  };
}

function feedbackPath(nodeId) {
  const from = nodeOutputPoint(nodeId);
  const to = nodeInputPoint(nodeId);
  const loopWidth = 118;
  return `M ${from.x} ${from.y} C ${from.x + loopWidth} ${from.y + 54}, ${to.x + loopWidth} ${to.y - 54}, ${to.x} ${to.y}`;
}

function feedbackMidpoint(nodeId) {
  const node = nodeById(nodeId);
  return { x: node.x + 92, y: node.y };
}

function linkEndpointPoint(to, visited = new Set()) {
  if (to === "audio") return audioInputPoint();
  if (nodeById(to)) return nodeInputPoint(to);
  if (linkById(to)) return linkInputPoint(to, visited);
  return null;
}

function linkInputPoint(id, visited = new Set()) {
  if (visited.has(id)) return null;
  const link = linkById(id);
  if (!link || !nodeById(link.from)) return null;

  visited.add(id);
  const to = linkEndpointPoint(link.to, visited);
  visited.delete(id);
  if (!to) return null;

  if (link.from === link.to) return feedbackMidpoint(link.from);
  return bezierPoint(nodeOutputPoint(link.from), to, LINK_INPUT_T);
}

function linkGeometry(link, visited = new Set()) {
  if (!link || !nodeById(link.from) || visited.has(link.id)) return null;
  visited.add(link.id);
  const from = nodeOutputPoint(link.from);
  const to = linkEndpointPoint(link.to, visited);
  visited.delete(link.id);
  if (!to) return null;

  const path = link.from === link.to ? feedbackPath(link.from) : bezierPath(from, to);
  const midpoint = link.from === link.to ? feedbackMidpoint(link.from) : bezierPoint(from, to, LINK_INPUT_T);
  return { from, to, path, midpoint };
}

function graphPayload() {
  return {
    nodes: state.nodes.map(({ id, wave, frequencyMode, ratio, frequency, speed }) => ({
      id,
      wave,
      frequencyMode,
      ratio,
      frequency,
      speed,
    })),
    links: state.links.map((link) => ({
      id: link.id,
      from: link.from,
      to: link.to,
      amount: Number(link.amount),
      delay: Number(link.delay) || 0,
      noise: Number(link.noise) || 0,
      pan: Number(link.pan) || 0,
      velocitySensitivity: Number(link.velocitySensitivity) || 0,
      modulationTarget: link.modulationTarget || "phase",
      drone: Boolean(link.drone),
      filter: { ...link.filter },
      envelope: { ...link.envelope },
    })),
    maxVoices: state.maxVoices,
    masterEffects: state.masterEffects,
  };
}

function postGraph() {
  if (!synthNode) return;
  synthNode.port.postMessage({
    type: "graph",
    payload: graphPayload(),
  });
}

function sendGraph({ immediate = false } = {}) {
  if (!synthNode) return;

  if (immediate) {
    if (pendingGraphFrame) {
      cancelAnimationFrame(pendingGraphFrame);
      pendingGraphFrame = null;
    }
    postGraph();
    return;
  }

  if (pendingGraphFrame) return;
  pendingGraphFrame = requestAnimationFrame(() => {
    pendingGraphFrame = null;
    postGraph();
  });
}

function scheduleLinkParamGraphSync() {
  clearTimeout(pendingLinkParamGraphSync);
  pendingLinkParamGraphSync = setTimeout(() => {
    pendingLinkParamGraphSync = null;
    sendGraph({ immediate: true });
  }, LINK_PARAM_GRAPH_SYNC_DELAY_MS);
}

function sendLinkParam(id, parameter, value) {
  synthNode?.port.postMessage({
    type: "linkParam",
    payload: { id, parameter, value },
  });
  scheduleLinkParamGraphSync();
}

function syncOutputMute() {
  if (!outputGainNode) return;
  const value = audioMuted ? 0 : 1;
  outputGainNode.gain.setTargetAtTime(value, audioContext?.currentTime || 0, 0.01);
}

function setAudioStatusLabel(text) {
  audioStatus.textContent = text;
  audioStatus.disabled = true;
  audioStatus.classList.remove("ready", "muted");
  audioStatus.removeAttribute("aria-pressed");
  audioStatus.title = text;
  audioStatus.setAttribute("aria-label", text);
}

function updateAudioReadyButton() {
  const label = audioMuted ? "Unmute" : "Mute";
  audioStatus.textContent = label;
  audioStatus.disabled = false;
  audioStatus.classList.toggle("ready", !audioMuted);
  audioStatus.classList.toggle("muted", audioMuted);
  audioStatus.setAttribute("aria-pressed", String(audioMuted));
  audioStatus.title = audioMuted ? "Unmute audio output" : "Mute audio output";
  audioStatus.setAttribute("aria-label", audioStatus.title);
}

function updateAudioStatus({ inputBlocked = false } = {}) {
  if (inputBlocked) {
    setAudioStatusLabel("Audio input blocked");
  } else if (audioContext && synthNode) {
    updateAudioReadyButton();
  } else {
    setAudioStatusLabel("Audio idle");
  }
}

function scheduleNodesAndWiresRender() {
  if (pendingNodesAndWiresFrame) return;
  pendingNodesAndWiresFrame = requestAnimationFrame(() => {
    pendingNodesAndWiresFrame = null;
    renderNodes();
    renderWires();
  });
}

function scheduleWiresRender() {
  if (pendingWiresFrame) return;
  pendingWiresFrame = requestAnimationFrame(() => {
    pendingWiresFrame = null;
    renderWires();
  });
}

async function ensureAudio() {
  if (!audioReadyPromise) {
    audioReadyPromise = setupAudio().finally(() => {
      audioReadyPromise = null;
    });
  }
  return audioReadyPromise;
}

async function setupAudio() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }

  if (!synthNode) {
    await audioContext.audioWorklet.addModule(AUDIO_WORKLET_MODULE_URL);
    synthNode = new AudioWorkletNode(audioContext, "visual-fm-engine", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      inputChannelCount: [2],
      outputChannelCount: [2],
    });
    outputGainNode = audioContext.createGain();
    syncOutputMute();
    synthNode.connect(outputGainNode);
    outputGainNode.connect(audioContext.destination);
    sendGraph({ immediate: true });
  }

  if (synthNode && !recorderDestination) {
    recorderDestination = audioContext.createMediaStreamDestination();
    synthNode.connect(recorderDestination);
  }

  if (audioContext.state !== "running") {
    await audioContext.resume();
  }
  let inputBlocked = false;
  if (patchUsesAudioInput()) {
    try {
      await ensureAudioInput();
    } catch {
      inputBlocked = true;
    }
  } else {
    stopAudioInput();
  }
  updateAudioStatus({ inputBlocked });
}

async function ensureAudioInput() {
  if (audioInputSource || !audioContext || !synthNode) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setAudioStatusLabel("Audio input unavailable");
    throw new Error("Audio input unavailable");
  }

  audioInputStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  audioInputSource = audioContext.createMediaStreamSource(audioInputStream);
  audioInputSource.connect(synthNode);
}

function stopAudioInput() {
  audioInputSource?.disconnect();
  audioInputStream?.getTracks().forEach((track) => track.stop());
  audioInputSource = null;
  audioInputStream = null;
}

async function reconcileAudioInput() {
  if (!patchUsesAudioInput()) {
    stopAudioInput();
    updateAudioStatus();
    return;
  }

  if (!audioContext || !synthNode) return;

  try {
    await ensureAudioInput();
    updateAudioStatus();
  } catch {
    updateAudioStatus({ inputBlocked: true });
  }
}

function showAudioEnableModal() {
  if (audioContext?.state === "running" || document.querySelector("[data-audio-enable-modal]")) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.dataset.audioEnableModal = "true";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="audioEnableHeading">
      <h2 id="audioEnableHeading">Visual FM</h2>
      <div class="modal-actions">
        <button class="text-button primary" id="enableAudioButton" type="button">Enable audio</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#enableAudioButton").addEventListener("click", async () => {
    try {
      await ensureAudio();
      overlay.remove();
    } catch {
      setAudioStatusLabel("Audio blocked");
    }
  });
}

function setRecordingButtonState(isRecording) {
  recordButton.classList.toggle("recording", isRecording);
  recordButton.setAttribute("aria-label", isRecording ? "Stop recording" : "Start recording");
  recordButton.title = isRecording ? "Stop recording" : "Start recording";
}

function recordingFileName(date = new Date()) {
  return `${slugifyPatchName(state.patchName || "visual-fm-patch")}-${timestampForFile(date)}.wav`;
}

async function exportRecording() {
  const sourceBlob = new Blob(recordingChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  if (!sourceBlob.size) return;

  const arrayBuffer = await sourceBlob.arrayBuffer();
  const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  downloadBlob(audioBufferToWav(decoded), recordingFileName(recordingStartedAt || new Date()));
}

async function startRecording() {
  if (recordingStarting || mediaRecorder?.state === "recording") return;

  const options = mediaRecorderOptions();
  if (options === null) {
    alert("Recording is not supported in this browser.");
    return;
  }

  recordingStarting = true;
  recordButton.disabled = true;
  try {
    await ensureAudio();
  } finally {
    recordingStarting = false;
    recordButton.disabled = false;
  }
  recordingChunks = [];
  recordingStartedAt = new Date();
  mediaRecorder = new MediaRecorder(recorderDestination.stream, options);
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) recordingChunks.push(event.data);
  });
  mediaRecorder.addEventListener("stop", async () => {
    recordButton.disabled = true;
    setRecordingButtonState(false);
    try {
      await exportRecording();
    } catch (error) {
      alert(`Could not export recording: ${error.message}`);
    } finally {
      recordButton.disabled = false;
      mediaRecorder = null;
      recordingChunks = [];
      recordingStartedAt = null;
    }
  }, { once: true });
  mediaRecorder.start();
  setRecordingButtonState(true);
}

function stopRecording() {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
  }
}

function toggleRecording() {
  if (recordingStarting) return;
  if (mediaRecorder?.state === "recording") {
    stopRecording();
  } else {
    startRecording().catch((error) => {
      alert(`Could not start recording: ${error.message}`);
    });
  }
}

function noteOn(note, velocity = 1) {
  ensureAudio().then(() => {
    synthNode?.port.postMessage({ type: "noteOn", payload: { note, velocity } });
  });
}

function noteOff(note) {
  synthNode?.port.postMessage({ type: "noteOff", payload: { note } });
}

async function setupMidi() {
  if (!navigator.requestMIDIAccess) {
    midiStatus.textContent = "MIDI unavailable";
    return;
  }

  try {
    const midi = await navigator.requestMIDIAccess();
    midiAccess = midi;
    const wireInput = (input) => {
      input.onmidimessage = (event) => {
        if (!isMidiInputSelected(input)) return;

        const [status, data1, value] = event.data;
        const command = status & 0xf0;
        const channel = (status & 0x0f) + 1;
        if (state.midiChannel !== "all" && channel !== Number(state.midiChannel)) {
          return;
        }

        if (command === 0x90 && value > 0) {
          noteOn(data1, value / 127);
        } else if (command === 0x80 || (command === 0x90 && value === 0)) {
          noteOff(data1);
        } else if (command === 0xb0) {
          recordRecentMidiCc(data1, value);
          capturePendingMidiCc(data1);
          applyMidiCc(data1, value);
        }
      };
    };

    midi.inputs.forEach(wireInput);
    midi.onstatechange = () => {
      midi.inputs.forEach(wireInput);
      updateMidiStatus(midi);
      if (!state.selected.type) {
        renderPanel();
      }
    };
    updateMidiStatus(midi);
  } catch {
    midiStatus.textContent = "MIDI blocked";
  }
}

function isMidiInputSelected(input) {
  return state.midiInputId === "all" || input.id === state.midiInputId;
}

function midiChannelLabel() {
  return state.midiChannel === "all" ? "all" : `ch ${state.midiChannel}`;
}

function midiInputs(midi = midiAccess) {
  return midi?.inputs ? [...midi.inputs.values()] : [];
}

function midiInputLabel(id = state.midiInputId, midi = midiAccess) {
  if (id === "all") return "all inputs";
  const input = midiInputs(midi).find((item) => item.id === id);
  return input?.name || "selected input";
}

function updateMidiStatus(midi = midiAccess) {
  const count = midi?.inputs?.size || 0;
  midiStatus.textContent = count ? `${midiInputLabel(state.midiInputId, midi)} · ${midiChannelLabel()}` : "No MIDI input";
  midiStatus.classList.toggle("ready", count > 0);
}

function renderNodes() {
  nodeLayer.innerHTML = "";

  for (const node of state.nodes) {
    const element = document.createElement("div");
    element.className = `node ${isNodeSelected(node.id) ? "selected" : ""}`;
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    element.dataset.nodeId = node.id;
    element.innerHTML = `
      <span class="anchor input" data-anchor="input" data-node-id="${escapeHtml(node.id)}" title="Input"></span>
      <div class="node-title">${escapeHtml(nodeName(node))}</div>
      <div class="node-meta"><span>${waveTypeLabel(node.wave)}</span><span>${nodeFrequencyLabel(node)}</span></div>
      <span class="anchor output" data-anchor="output" data-node-id="${escapeHtml(node.id)}" title="Output"></span>
    `;

    element.addEventListener("pointerdown", onNodePointerDown);
    element.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    nodeLayer.appendChild(element);
  }
}

function renderAudioOut() {
  audioOut.classList.toggle("selected", state.selected.type === "audio");
  audioOut.dataset.midiTargetType = "audio";
  audioOut.dataset.midiTargetId = "audio";
}

function renderWires() {
  stage.classList.toggle("link-dragging", Boolean(linkDrag));
  wireLayer.innerHTML = "";

  for (const link of state.links) {
    const geometry = linkGeometry(link);
    if (!geometry) continue;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const visible = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const anchor = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const anchorHit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const anchorDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");

    visible.setAttribute("d", geometry.path);
    visible.setAttribute("class", `wire ${link.to === "audio" ? "output" : ""} ${linkById(link.to) ? "link-mod" : ""} ${link.from === link.to ? "feedback" : ""} ${state.selected.type === "link" && state.selected.id === link.id ? "selected" : ""}`);
    visible.dataset.midiTargetType = "link";
    visible.dataset.midiTargetId = link.id;

    hit.setAttribute("d", geometry.path);
    hit.setAttribute("class", "wire-hit");
    hit.addEventListener("click", (event) => {
      event.stopPropagation();
      select("link", link.id);
    });

    anchor.setAttribute("class", `link-anchor input ${state.selected.type === "link" && state.selected.id === link.id ? "selected" : ""}`);
    anchor.dataset.linkId = link.id;
    anchor.dataset.midiTargetType = "link";
    anchor.dataset.midiTargetId = link.id;
    anchorHit.setAttribute("cx", geometry.midpoint.x);
    anchorHit.setAttribute("cy", geometry.midpoint.y);
    anchorHit.setAttribute("r", "22");
    anchorHit.setAttribute("class", "link-anchor-hit");
    anchorDot.setAttribute("cx", geometry.midpoint.x);
    anchorDot.setAttribute("cy", geometry.midpoint.y);
    anchorDot.setAttribute("r", "8");
    anchorDot.setAttribute("class", "link-anchor-dot");
    anchor.addEventListener("click", (event) => {
      event.stopPropagation();
      select("link", link.id);
    });
    anchor.append(anchorHit, anchorDot);

    group.append(visible, hit, anchor);
    wireLayer.appendChild(group);
  }

  if (linkDrag) {
    const preview = document.createElementNS("http://www.w3.org/2000/svg", "path");
    preview.setAttribute("d", bezierPath(nodeOutputPoint(linkDrag.from), linkDrag.to));
    preview.setAttribute("class", "wire selected wire-preview");
    preview.setAttribute("stroke-dasharray", "7 7");
    wireLayer.appendChild(preview);
  }
}

function drawAdsr(envelope) {
  const width = 276;
  const height = 116;
  const left = 14;
  const right = 262;
  const bottom = 94;
  const top = 20;
  const timelineWidth = right - left;
  const delay = Math.max(0, envelope.delay || 0);
  const attack = Math.max(0.001, envelope.attack);
  const decay = Math.max(0.001, envelope.decay);
  const release = Math.max(0.001, envelope.release);
  const sustain = clamp(envelope.sustain, 0, 1);
  const sustainHold = 0.55;
  const total = delay + attack + decay + release + sustainHold;
  const delayWidth = Math.max(delay > 0 ? 8 : 0, (delay / total) * timelineWidth);
  const attackWidth = Math.max(8, (attack / total) * timelineWidth);
  const decayWidth = Math.max(8, (decay / total) * timelineWidth);
  const releaseWidth = Math.max(8, (release / total) * timelineWidth);
  const used = delayWidth + attackWidth + decayWidth + releaseWidth;
  const holdWidth = Math.max(16, timelineWidth - used);
  const scale = timelineWidth / (delayWidth + attackWidth + decayWidth + holdWidth + releaseWidth);
  const delayX = left + delayWidth * scale;
  const attackX = delayX + attackWidth * scale;
  const decayX = attackX + decayWidth * scale;
  const sustainX = decayX + holdWidth * scale;
  const releaseX = right;
  const sustainY = bottom - (bottom - top) * sustain;
  const attackControl = Math.max(6, (attackX - delayX) * 0.35);
  const decayControl = Math.max(6, (decayX - attackX) * 0.45);
  const releaseControl = Math.max(6, (releaseX - sustainX) * 0.5);
  const points = [
    [left, bottom],
    [delayX, bottom],
    [attackX, top],
    [decayX, sustainY],
    [sustainX, sustainY],
    [releaseX, bottom],
  ];
  const line = `
    M ${left} ${bottom}
    L ${delayX} ${bottom}
    C ${delayX + attackControl * 0.35} ${bottom}, ${attackX - attackControl} ${top}, ${attackX} ${top}
    C ${attackX + decayControl} ${top}, ${decayX - decayControl * 0.5} ${sustainY}, ${decayX} ${sustainY}
    L ${sustainX} ${sustainY}
    C ${sustainX + releaseControl * 0.45} ${sustainY}, ${releaseX - releaseControl} ${bottom}, ${releaseX} ${bottom}
  `;
  const fill = `${line} L ${releaseX} ${bottom} L ${left} ${bottom} Z`;
  return `
    <svg class="adsr-view" viewBox="0 0 ${width} ${height}" role="img" aria-label="Envelope">
      <path d="${fill}" fill="rgba(117, 208, 164, 0.16)"></path>
      <path d="${line}" fill="none" stroke="#75d0a4" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
      ${points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4" fill="#f1f4f2"></circle>`).join("")}
    </svg>
  `;
}

function renderPanel() {
  const selection = state.selected;
  if (selection.type === "nodes") {
    const count = selectedNodeIds().length;
    panel.innerHTML = `
      <h1>${count} nodes selected</h1>
      <p class="panel-subtitle">Drag any selected node to move the group.</p>
    `;
    return;
  }

  if (selection.type === "node") {
    const node = nodeById(selection.id);
    if (!node) return renderEmptyPanel();
    const usesPitchControls = isPitchedWave(node.wave);
    const usesSpeedControl = isSpeedWave(node.wave);
    const isFixedFrequency = node.frequencyMode === "fixed";
    const frequencyValue = isFixedFrequency ? node.frequency : node.ratio;
    const frequencyMin = 0;
    const frequencyMax = isFixedFrequency ? 12000 : 16;
    const frequencyStep = isFixedFrequency ? 0.01 : 0.001;
    const speedValue = Number.isFinite(Number(node.speed)) ? node.speed : 8;

    panel.innerHTML = `
      <h1 id="nodeHeading">${escapeHtml(nodeName(node))}</h1>
      <p class="panel-subtitle">Oscillator</p>
      <div class="field">
        <label for="nodeName">Name</label>
        <input id="nodeName" type="text" value="${escapeHtml(nodeName(node))}" autocomplete="off">
      </div>
      <div class="field">
        ${parameterLabel("wave", "Wave type", "node", node.id, "wave")}
        <select id="wave">
          ${WAVE_TYPES.map((wave) => `<option value="${wave}" ${node.wave === wave ? "selected" : ""}>${waveTypeLabel(wave)}</option>`).join("")}
        </select>
      </div>
      ${usesPitchControls ? `
        <div class="field">
          ${parameterLabel("frequencyMode", "Tuning", "node", node.id, "frequencyMode")}
          <select id="frequencyMode">
            <option value="ratio" ${node.frequencyMode === "ratio" ? "selected" : ""}>Ratio</option>
            <option value="fixed" ${node.frequencyMode === "fixed" ? "selected" : ""}>Fixed</option>
          </select>
        </div>
        <div class="field">
          ${parameterLabel("frequencyValue", isFixedFrequency ? "Frequency (Hz)" : "Ratio (x)", "node", node.id, isFixedFrequency ? "frequency" : "ratio")}
          <div class="field-row">
            <input id="frequencyValueRange" type="range" min="${frequencyMin}" max="${frequencyMax}" step="${frequencyStep}" value="${frequencyValue}">
            <input id="frequencyValue" type="number" min="${frequencyMin}" max="${frequencyMax}" step="${frequencyStep}" value="${frequencyValue}">
          </div>
        </div>
      ` : ""}
      ${usesSpeedControl ? `
        <div class="field">
          ${parameterLabel("speed", "Speed", "node", node.id, "speed")}
          <div class="field-row">
            <input id="speedRange" type="range" min="0.01" max="60" step="0.001" value="${speedValue}">
            <input id="speed" type="number" min="0.01" max="60" step="0.001" value="${speedValue}">
          </div>
        </div>
      ` : ""}
    `;

    panel.querySelector("#nodeName").addEventListener("input", (event) => {
      node.name = event.target.value;
      panel.querySelector("#nodeHeading").textContent = nodeName(node);
      renderNodes();
      savePatch();
    });
    panel.querySelector("#nodeName").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.currentTarget.blur();
      }
    });
    panel.querySelector("#wave").addEventListener("change", (event) => {
      node.wave = event.target.value;
      if (node.wave === "audio-input") {
        ensureAudio().catch(() => {
          setAudioStatusLabel("Audio input blocked");
        });
      } else {
        reconcileAudioInput();
      }
      pruneMidiBindings();
      renderPanel();
      renderNodes();
      sendGraph();
      savePatch();
    });
    if (usesPitchControls) {
      panel.querySelector("#frequencyMode").addEventListener("change", (event) => {
        node.frequencyMode = event.target.value;
        render();
        sendGraph();
        savePatch();
      });
      bindNumberPair("frequencyValue", "frequencyValueRange", frequencyMin, frequencyMax, (value) => {
        if (node.frequencyMode === "fixed") {
          node.frequency = value;
        } else {
          node.ratio = value;
        }
        renderNodes();
        sendGraph();
        savePatch();
      });
    }
    if (usesSpeedControl) {
      bindNumberPair("speed", "speedRange", 0.01, 60, (value) => {
        node.speed = value;
        renderNodes();
        sendGraph();
        savePatch();
      });
    }
    attachParameterMidiButtons();
    return;
  }

  if (selection.type === "audio") {
    renderMasterEffectsPanel();
    return;
  }

  if (selection.type === "link") {
    const link = linkById(selection.id);
    if (!link) return renderEmptyPanel();
    const from = nodeName(nodeById(link.from));
    const to = targetName(link.to);
    const targetKind = linkTargetKind(link);
    const modulationTargets = modulationTargetsForLink(link);
    const amountMax = link.modulationTarget === "mix" ? 1 : 8;
    const usesEnvelopeControls = !link.drone;
    const filterControls = link.filter.type === "none" ? "" : `
      <div class="field">
        ${parameterLabel("filterCutoff", "Cutoff (Hz)", "link", link.id, "filter.cutoff")}
        <div class="field-row">
          <input id="filterCutoffRange" type="range" min="20" max="12000" step="1" value="${link.filter.cutoff}">
          <input id="filterCutoff" type="number" min="20" max="12000" step="1" value="${link.filter.cutoff}">
        </div>
      </div>
      <div class="field">
        ${parameterLabel("filterResonance", "Resonance", "link", link.id, "filter.resonance")}
        <div class="field-row">
          <input id="filterResonanceRange" type="range" min="0.1" max="12" step="0.001" value="${link.filter.resonance}">
          <input id="filterResonance" type="number" min="0.1" max="12" step="0.001" value="${link.filter.resonance}">
        </div>
      </div>
    `;
    if (modulationTargets.length && !modulationTargets.includes(link.modulationTarget)) {
      link.modulationTarget = modulationTargets[0];
      sendGraph();
      savePatch();
    }
    const envelopeControls = usesEnvelopeControls ? `
      <section class="effect-section">
        <div class="section-title">Envelope</div>
        ${drawAdsr(link.envelope)}
        <div class="adsr-slider-grid">
          ${adsrField("delay", "D", "Delay", link.envelope.delay, 0, 4, link.id)}
          ${adsrField("attack", "A", "Attack", link.envelope.attack, 0.001, 4, link.id)}
          ${adsrField("decay", "D", "Decay", link.envelope.decay, 0.001, 4, link.id)}
          ${adsrField("sustain", "S", "Sustain", link.envelope.sustain, 0, 1, link.id)}
          ${adsrField("release", "R", "Release", link.envelope.release, 0.001, 6, link.id)}
        </div>
      </section>
    ` : "";

    panel.innerHTML = `
      <h1>${link.to === "audio" ? "Output envelope" : targetKind === "link" ? "Link modulation" : "Modulation"}</h1>
      <p class="panel-subtitle">${from} -> ${to}</p>
      ${modulationTargets.length ? `
        <div class="field">
          ${parameterLabel("modulationTarget", "Modulates", "link", link.id, "modulationTarget")}
          <select id="modulationTarget">
            ${modulationTargets.map((target) => `<option value="${target}" ${link.modulationTarget === target ? "selected" : ""}>${modulationTargetLabel(target, to)}</option>`).join("")}
          </select>
        </div>
      ` : ""}
      <div class="field">
        ${parameterLabel("amount", "Amplitude", "link", link.id, "amount")}
        <div class="field-row">
          <input id="amountRange" type="range" min="0" max="${amountMax}" step="0.001" value="${clamp(link.amount, 0, amountMax)}">
          <input id="amount" type="number" min="0" max="${amountMax}" step="0.001" value="${clamp(link.amount, 0, amountMax)}">
        </div>
      </div>
      ${link.to === "audio" ? `
        <div class="field">
          ${parameterLabel("pan", "Pan", "link", link.id, "pan")}
          <div class="field-row">
            <input id="panRange" type="range" min="-1" max="1" step="0.001" value="${link.pan}">
            <input id="pan" type="number" min="-1" max="1" step="0.001" value="${link.pan}">
          </div>
        </div>
      ` : ""}
      <div class="field">
        ${parameterLabel("velocitySensitivity", "Velocity sensitivity", "link", link.id, "velocitySensitivity")}
        <div class="field-row">
          <input id="velocitySensitivityRange" type="range" min="${VELOCITY_SENSITIVITY_MIN}" max="${VELOCITY_SENSITIVITY_MAX}" step="0.001" value="${link.velocitySensitivity}">
          <input id="velocitySensitivity" type="number" min="${VELOCITY_SENSITIVITY_MIN}" max="${VELOCITY_SENSITIVITY_MAX}" step="0.001" value="${link.velocitySensitivity}">
        </div>
      </div>
      <div class="field">
        ${parameterLabel("noise", "Noise", "link", link.id, "noise")}
        <div class="field-row">
          <input id="noiseRange" type="range" min="0" max="1" step="0.001" value="${Number(link.noise) || 0}">
          <input id="noise" type="number" min="0" max="1" step="0.001" value="${Number(link.noise) || 0}">
        </div>
      </div>
      <div class="field">
        ${parameterLabel("linkDelay", "Delay buffer", "link", link.id, "delay")}
        <div class="field-row">
          <input id="linkDelayRange" type="range" min="0" max="3" step="0.001" value="${link.delay}">
          <input id="linkDelay" type="number" min="0" max="3" step="0.001" value="${link.delay}">
        </div>
      </div>
      <div class="toggle-field">
        <label class="toggle-row" for="drone">
          <input id="drone" type="checkbox" ${link.drone ? "checked" : ""}>
          <span>Drone</span>
        </label>
        ${midiCcButton("link", link.id, "drone")}
      </div>
      ${envelopeControls}
      <section class="effect-section">
        <div class="section-title">Filter</div>
        <div class="field">
          ${parameterLabel("filterType", "Type", "link", link.id, "filter.type")}
          <select id="filterType">
            ${LINK_FILTER_TYPES.map((type) => `<option value="${type}" ${link.filter.type === type ? "selected" : ""}>${filterTypeLabel(type)}</option>`).join("")}
          </select>
        </div>
        ${filterControls}
      </section>
    `;

    bindNumberPair("amount", "amountRange", 0, amountMax, (value) => {
      link.amount = value;
      sendLinkParam(link.id, "amount", value);
      schedulePatchSave();
    });

    if (link.to === "audio") {
      bindNumberPair("pan", "panRange", -1, 1, (value) => {
        link.pan = value;
        sendLinkParam(link.id, "pan", value);
        schedulePatchSave();
      });
    }

    bindNumberPair("velocitySensitivity", "velocitySensitivityRange", VELOCITY_SENSITIVITY_MIN, VELOCITY_SENSITIVITY_MAX, (value) => {
      link.velocitySensitivity = value;
      sendLinkParam(link.id, "velocitySensitivity", value);
      schedulePatchSave();
    });

    bindNumberPair("noise", "noiseRange", 0, 1, (value) => {
      link.noise = value;
      sendLinkParam(link.id, "noise", value);
      schedulePatchSave();
    });

    bindNumberPair("linkDelay", "linkDelayRange", 0, 3, (value) => {
      link.delay = value;
      sendLinkParam(link.id, "delay", value);
      schedulePatchSave();
    });

    panel.querySelector("#drone").addEventListener("change", (event) => {
      link.drone = event.target.checked;
      if (link.drone) ensureAudio();
      renderPanel();
      sendGraph();
      savePatch();
    });

    panel.querySelector("#modulationTarget")?.addEventListener("change", (event) => {
      link.modulationTarget = event.target.value;
      if (link.modulationTarget === "mix") {
        link.amount = clamp(link.amount, 0, 1);
        renderPanel();
      }
      sendGraph();
      savePatch();
    });

    panel.querySelector("#filterType").addEventListener("change", (event) => {
      link.filter.type = event.target.value;
      renderPanel();
      sendGraph();
      savePatch();
    });

    if (link.filter.type !== "none") {
      bindNumberPair("filterCutoff", "filterCutoffRange", 20, 12000, (value) => {
        link.filter.cutoff = value;
        sendLinkParam(link.id, "filter.cutoff", value);
        schedulePatchSave();
      });

      bindNumberPair("filterResonance", "filterResonanceRange", 0.1, 12, (value) => {
        link.filter.resonance = value;
        sendLinkParam(link.id, "filter.resonance", value);
        schedulePatchSave();
      });
    }

    if (usesEnvelopeControls) {
      for (const name of ["delay", "attack", "decay", "sustain", "release"]) {
        const max = name === "sustain" ? 1 : name === "release" ? 6 : 4;
        const min = name === "delay" || name === "sustain" ? 0 : 0.001;
        bindNumberPair(name, `${name}Range`, min, max, (value) => {
          link.envelope[name] = value;
          refreshAdsrView(link.envelope);
          sendGraph();
          savePatch();
        });
      }
    }

    attachParameterMidiButtons();
    return;
  }

  renderEmptyPanel();
}

function renderMasterEffectsPanel() {
  panel.innerHTML = `
    <h1>Audio Out</h1>
    <p class="panel-subtitle">Master effects</p>
    ${effectSection("chorus", effectLabel("chorus"), state.masterEffects.chorus, effectParameterSpecs("chorus"))}
    ${effectSection("delay", effectLabel("delay"), state.masterEffects.delay, effectParameterSpecs("delay"))}
    ${effectSection("reverb", effectLabel("reverb"), state.masterEffects.reverb, effectParameterSpecs("reverb"))}
  `;

  for (const effectName of MASTER_EFFECT_IDS) {
    const effect = state.masterEffects[effectName];
    const toggle = panel.querySelector(`#${effectName}Enabled`);
    toggle.addEventListener("change", (event) => {
      effect.enabled = event.target.checked;
      sendGraph();
      savePatch();
    });

    for (const input of panel.querySelectorAll(`[data-effect="${effectName}"]`)) {
      const key = input.dataset.param;
      bindNumberPair(`${effectName}-${key}`, `${effectName}-${key}Range`, Number(input.min), Number(input.max), (value) => {
        effect[key] = value;
        sendGraph();
        savePatch();
      });
    }
  }

  attachParameterMidiButtons();
}

function downloadPatch() {
  downloadPatchFile(currentPatchData());
}

async function loadPatchFile(file) {
  if (!file) return;

  try {
    const text = await file.text();
    const patch = parsePatchFile(text);
    applyPatchData(patch);
  } catch (error) {
    alert(`Could not load patch: ${error.message}`);
  } finally {
    const input = panel.querySelector("#loadPatchInput");
    if (input) input.value = "";
  }
}

function applyPatchData(patch) {
  const normalized = normalizePatch(patch);
  state.patchName = normalized.patchName;
  state.maxVoices = normalized.maxVoices;
  state.midiChannel = normalized.midiChannel;
  state.midiInputId = normalized.midiInputId;
  state.midiBindings = normalized.midiBindings;
  state.masterEffects = normalized.masterEffects;
  state.nodes = normalized.nodes;
  state.links = normalized.links;
  state.selected = state.nodes[0] ? { type: "node", id: state.nodes[0].id } : { type: null, id: null };
  syncCounters();
  synthNode?.port.postMessage({ type: "panic" });
  pressedKeys.clear();
  updateMidiStatus();
  render();
  sendGraph();
  reconcileAudioInput();
  savePatch();
}

function newPatch() {
  if (!confirm("Clear the current patch and start a new one? Unsaved changes will be lost.")) {
    return;
  }

  const midiChannel = state.midiChannel;
  const midiInputId = state.midiInputId;
  const normalized = normalizeDefaultPatch();
  state.patchName = "Untitled Patch";
  state.maxVoices = normalized.maxVoices;
  state.midiChannel = midiChannel;
  state.midiInputId = midiInputId;
  state.midiBindings = normalized.midiBindings;
  state.masterEffects = normalized.masterEffects;
  state.nodes = normalized.nodes;
  state.links = normalized.links;
  state.selected = { type: null, id: null };
  syncCounters();
  synthNode?.port.postMessage({ type: "panic" });
  pressedKeys.clear();
  updateMidiStatus();
  render();
  sendGraph();
  reconcileAudioInput();
  savePatch();
}

function effectSection(id, title, effect, params) {
  return `
    <section class="effect-section">
      <div class="toggle-field">
        <label class="toggle-row" for="${id}Enabled">
          <input id="${id}Enabled" type="checkbox" ${effect.enabled ? "checked" : ""}>
          <span>${title}</span>
        </label>
        ${midiCcButton("effect", id, "enabled")}
      </div>
      ${params.map(([key, label, min, max, unit]) => effectField(id, key, label, effect[key], min, max, unit)).join("")}
    </section>
  `;
}

function effectField(effectId, key, label, value, min, max, unit) {
  const id = `${effectId}-${key}`;
  const step = max <= 1 ? 0.001 : 0.01;
  return `
    <div class="field">
      ${parameterLabel(id, `${label}${unit ? ` (${unit})` : ""}`, "effect", effectId, key)}
      <div class="field-row">
        <input id="${id}Range" type="range" min="${min}" max="${max}" step="${step}" value="${value}">
        <input id="${id}" data-effect="${effectId}" data-param="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${value}">
      </div>
    </div>
  `;
}

function filterTypeLabel(type) {
  const labels = {
    none: "None",
    lowpass: "Low-pass",
    highpass: "High-pass",
    bandpass: "Band-pass",
  };
  return labels[type] || type;
}

function waveTypeLabel(type) {
  const labels = {
    "sample-hold": "sample & hold",
    "audio-input": "audio input",
  };
  return labels[type] || type;
}

function nodeFrequencyLabel(node) {
  if (node.wave === "audio-input") return "line in";
  if (node.wave === "noise") return "random";
  if (isSpeedWave(node.wave)) {
    const speed = Number(node.speed);
    const label = speed < 10 ? speed.toFixed(2) : speed < 100 ? speed.toFixed(1) : String(Math.round(speed));
    return `${label} Hz`;
  }
  if (node.frequencyMode === "fixed") {
    const frequency = Number(node.frequency);
    const label = frequency < 10 ? frequency.toFixed(2) : frequency < 100 ? frequency.toFixed(1) : String(Math.round(frequency));
    return `${label} Hz`;
  }
  return `${Number(node.ratio).toFixed(2)}x`;
}

function modulationTargetLabel(target, destination = "") {
  const labels = {
    phase: "Phase (default)",
    frequency: "Frequency",
    ring: "Ring",
    fold: "Fold",
    mix: "Mix",
    filterCutoff: "Filter cutoff",
    filterResonance: "Filter resonance",
    amplitude: "Amplitude",
    delay: "Delay buffer",
    noise: "Noise",
    pan: "Pan",
    envelopeTrigger: "Envelope trigger",
    "envelope.delay": "Envelope delay",
    "envelope.attack": "Envelope attack",
    "envelope.decay": "Envelope decay",
    "envelope.sustain": "Envelope sustain",
    "envelope.release": "Envelope release",
  };
  return labels[target] || target;
}

function modulationTargetsForLink(link) {
  const kind = linkTargetKind(link);
  if (kind === "link") {
    const targetLink = linkById(link.to);
    return linkHasPan(targetLink)
      ? LINK_MODULATION_TARGETS
      : LINK_MODULATION_TARGETS.filter((target) => target !== "pan");
  }
  if (kind === "node") return NODE_MODULATION_TARGETS;
  return [];
}

function adsrField(name, letter, label, value, min, max, linkId) {
  return `
    <div class="adsr-slider-field">
      <div class="adsr-slider-label">
        <label for="${name}Range" title="${escapeHtml(label)}">${escapeHtml(letter)}</label>
        ${midiCcButton("link", linkId, `envelope.${name}`)}
      </div>
      <input class="adsr-slider" id="${name}Range" type="range" min="${min}" max="${max}" step="0.001" value="${value}" aria-label="${escapeHtml(label)}">
      <input class="adsr-value" id="${name}" type="number" min="${min}" max="${max}" step="0.001" value="${value}" aria-label="${escapeHtml(label)} value">
    </div>
  `;
}

function bindNumberPair(numberId, rangeId, min, max, onValue) {
  const number = panel.querySelector(`#${numberId}`);
  const range = panel.querySelector(`#${rangeId}`);

  const commitValue = (rawValue, { updateNumber = true } = {}) => {
    if (rawValue === "" || rawValue === "." || rawValue === "-") return;

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return;

    const value = clamp(parsed, min, max);
    if (updateNumber) {
      number.value = String(value);
    }
    range.value = String(value);
    onValue(value);
  };

  number.addEventListener("input", (event) => commitValue(event.target.value, { updateNumber: false }));
  number.addEventListener("focus", (event) => event.target.select());
  number.addEventListener("pointerup", (event) => {
    event.preventDefault();
    event.target.select();
  });
  number.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      commitValue(event.currentTarget.value);
      event.currentTarget.blur();
    }
  });
  number.addEventListener("blur", (event) => commitValue(event.target.value));
  range.addEventListener("input", (event) => commitValue(event.target.value));
  bindPrecisionRangeDrag(range, min, max, commitValue);
}

function bindPrecisionRangeDrag(range, min, max, commitValue) {
  const rangeSpan = max - min;
  if (!range || rangeSpan <= 0) return;

  let drag = null;
  const valueFromPointer = (event, rect) => {
    const vertical = rect.height > rect.width;
    const axisSize = vertical ? rect.height : rect.width;
    if (axisSize <= 0) return Number(range.value);

    const normal = vertical
      ? 1 - (event.clientY - rect.top) / axisSize
      : (event.clientX - rect.left) / axisSize;
    return min + clamp(normal, 0, 1) * rangeSpan;
  };
  const thumbAxisPosition = (value, rect, vertical) => {
    const normal = clamp((value - min) / rangeSpan, 0, 1);
    return vertical
      ? rect.top + (1 - normal) * rect.height
      : rect.left + normal * rect.width;
  };
  const fineScale = (event) => (event.altKey || isFineSliderActive() ? FINE_SLIDER_SCALE : 1);

  range.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const rect = range.getBoundingClientRect();
    const vertical = rect.height > rect.width;
    const currentValue = clamp(Number(range.value), min, max);
    const pointerAxis = vertical ? event.clientY : event.clientX;
    const thumbAxis = thumbAxisPosition(currentValue, rect, vertical);
    const thumbRadius = Math.max(14, (vertical ? rect.width : rect.height) * 0.5);
    const grabbedThumb = Math.abs(pointerAxis - thumbAxis) <= thumbRadius;
    const startValue = grabbedThumb ? currentValue : valueFromPointer(event, rect);
    drag = {
      pointerId: event.pointerId,
      rect,
      vertical,
      currentValue: startValue,
      lastAxis: pointerAxis,
    };

    range.setPointerCapture?.(event.pointerId);
    if (!grabbedThumb) {
      commitValue(startValue);
    }
  });

  range.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();

    const axisSize = drag.vertical ? drag.rect.height : drag.rect.width;
    if (axisSize <= 0) return;

    const axis = drag.vertical ? event.clientY : event.clientX;
    const perpendicular = drag.vertical
      ? Math.abs(event.clientX - (drag.rect.left + drag.rect.width * 0.5))
      : Math.abs(event.clientY - (drag.rect.top + drag.rect.height * 0.5));
    const precision = 1 / (1 + Math.pow(perpendicular / 90, 1.35));
    const axisDelta = drag.vertical
      ? (drag.lastAxis - axis) / axisSize
      : (axis - drag.lastAxis) / axisSize;
    const value = drag.currentValue + axisDelta * precision * fineScale(event) * rangeSpan;

    drag.currentValue = clamp(value, min, max);
    drag.lastAxis = axis;
    commitValue(drag.currentValue);
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    range.releasePointerCapture?.(event.pointerId);
    drag = null;
  };

  range.addEventListener("pointerup", endDrag);
  range.addEventListener("pointercancel", endDrag);
}

function isFineSliderActive() {
  return touchFineSliderPointerId !== null || keyboardFineSliderActive;
}

function syncFineSliderButton() {
  const active = isFineSliderActive();
  fineSliderButton?.classList.toggle("is-active", active);
  fineSliderButton?.setAttribute("aria-pressed", String(active));
}

function setKeyboardFineSliderActive(active) {
  keyboardFineSliderActive = active;
  syncFineSliderButton();
}

function releaseTouchFineSlider(pointerId = touchFineSliderPointerId) {
  if (touchFineSliderPointerId !== pointerId) return;
  fineSliderButton?.releasePointerCapture?.(pointerId);
  touchFineSliderPointerId = null;
  syncFineSliderButton();
}

function refreshAdsrView(envelope) {
  const current = panel.querySelector(".adsr-view");
  if (!current) return;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = drawAdsr(envelope).trim();
  current.replaceWith(wrapper.firstElementChild);
}

function selectionBounds(start, current) {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

function renderSelectionRect() {
  if (!marqueeState?.active) {
    selectionRect.style.display = "none";
    return;
  }

  const bounds = selectionBounds(marqueeState.start, marqueeState.current);
  selectionRect.style.display = "block";
  selectionRect.style.left = `${bounds.x}px`;
  selectionRect.style.top = `${bounds.y}px`;
  selectionRect.style.width = `${bounds.width}px`;
  selectionRect.style.height = `${bounds.height}px`;
}

function nodesInsideSelection() {
  if (!marqueeState) return [];
  const bounds = selectionBounds(marqueeState.start, marqueeState.current);
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  return state.nodes
    .filter((node) => node.x >= bounds.x && node.x <= right && node.y >= bounds.y && node.y <= bottom)
    .map((node) => node.id);
}

function midiElementValue(targetType, targetId) {
  return `${targetType}:${targetId}`;
}

function midiSelectionForBinding(binding) {
  if (binding.targetType === "effect") {
    return { type: "audio", id: "audio" };
  }
  return { type: binding.targetType, id: binding.targetId };
}

function midiCanvasTargetForBinding(binding) {
  if (binding.targetType === "effect") {
    return { type: "audio", id: "audio" };
  }
  return { type: binding.targetType, id: binding.targetId };
}

function isMidiCanvasTargetSelected(target) {
  if (target.type === "node") return isNodeSelected(target.id);
  if (target.type === "link") return state.selected.type === "link" && state.selected.id === target.id;
  if (target.type === "audio") return state.selected.type === "audio";
  return false;
}

function parseMidiElementValue(value) {
  const separator = value.indexOf(":");
  if (separator === -1) return { targetType: "node", targetId: value };
  return {
    targetType: value.slice(0, separator),
    targetId: value.slice(separator + 1),
  };
}

function renderMidiBindingItems() {
  if (!state.midiBindings.length) {
    return `<p class="midi-empty">No MIDI CC bindings yet.</p>`;
  }

  return `
    <div class="midi-binding-list">
      ${state.midiBindings.map((binding) => `
        <div class="midi-binding-item" data-midi-binding-item="${escapeHtml(binding.id)}">
          <div class="midi-binding-copy">
            <button
              class="midi-target-link"
              type="button"
              data-midi-select-target-type="${escapeHtml(midiSelectionForBinding(binding).type)}"
              data-midi-select-target-id="${escapeHtml(midiSelectionForBinding(binding).id)}"
            >${escapeHtml(midiElementLabel(binding.targetType, binding.targetId))}</button>
            <span>${escapeHtml(midiParameterLabel(binding))} · CC ${binding.cc}</span>
          </div>
          <div class="binding-actions">
            <button class="text-button compact" type="button" data-midi-edit="${escapeHtml(binding.id)}">Edit</button>
            <button class="text-button compact danger" type="button" data-midi-remove="${escapeHtml(binding.id)}">Remove</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderMidiBindingsSection() {
  return `
    <section class="effect-section midi-section">
      <div class="section-heading">
        <div class="section-title">MIDI CC</div>
        <button class="text-button compact" id="newMidiBindingButton" type="button">New binding</button>
      </div>
      ${renderMidiBindingItems()}
    </section>
  `;
}

function flashMidiBindingItem(bindingId) {
  for (const item of document.querySelectorAll(`[data-midi-binding-item="${CSS.escape(bindingId)}"]`)) {
    item.classList.add("active");
  }
  clearTimeout(midiBindingFlashTimers.get(bindingId));
  midiBindingFlashTimers.set(bindingId, setTimeout(() => {
    midiBindingFlashTimers.delete(bindingId);
    for (const item of document.querySelectorAll(`[data-midi-binding-item="${CSS.escape(bindingId)}"]`)) {
      item.classList.remove("active");
    }
  }, 500));
}

function midiCanvasTargetElements(target) {
  if (target.type === "node") {
    return [...nodeLayer.querySelectorAll(`[data-node-id="${CSS.escape(target.id)}"]`)]
      .filter((element) => element.classList.contains("node"));
  }

  if (target.type === "link") {
    return [...wireLayer.querySelectorAll(
      `[data-midi-target-type="link"][data-midi-target-id="${CSS.escape(target.id)}"]`,
    )];
  }

  if (target.type === "audio") {
    return [audioOut];
  }

  return [];
}

function flashMidiCanvasTarget(binding) {
  const target = midiCanvasTargetForBinding(binding);
  if (isMidiCanvasTargetSelected(target)) return;

  const key = `${target.type}:${target.id}`;
  for (const element of midiCanvasTargetElements(target)) {
    element.classList.add("midi-active");
  }
  clearTimeout(midiTargetFlashTimers.get(key));
  midiTargetFlashTimers.set(key, setTimeout(() => {
    midiTargetFlashTimers.delete(key);
    for (const element of midiCanvasTargetElements(target)) {
      element.classList.remove("midi-active");
    }
  }, 500));
}

function attachMidiBindingEvents() {
  panel.querySelector("#newMidiBindingButton")?.addEventListener("click", () => openMidiBindingModal());
  for (const button of panel.querySelectorAll("[data-midi-select-target-type]")) {
    button.addEventListener("click", () => {
      select(button.dataset.midiSelectTargetType, button.dataset.midiSelectTargetId);
    });
  }
  for (const button of panel.querySelectorAll("[data-midi-edit]")) {
    button.addEventListener("click", () => openMidiBindingModal(button.dataset.midiEdit));
  }
  for (const button of panel.querySelectorAll("[data-midi-remove]")) {
    button.addEventListener("click", () => {
      state.midiBindings = state.midiBindings.filter((binding) => binding.id !== button.dataset.midiRemove);
      renderEmptyPanel();
      savePatch();
    });
  }
}

function renderMidiElementOptions(selectedValue) {
  const nodeOptions = state.nodes.map((node) => {
    const value = midiElementValue("node", node.id);
    return `<option value="${escapeHtml(value)}" ${selectedValue === value ? "selected" : ""}>${escapeHtml(nodeName(node))}</option>`;
  }).join("");
  const linkOptions = state.links.map((link) => {
    const value = midiElementValue("link", link.id);
    return `<option value="${escapeHtml(value)}" ${selectedValue === value ? "selected" : ""}>${escapeHtml(linkName(link))}</option>`;
  }).join("");
  const effectOptions = MASTER_EFFECT_IDS.map((effectId) => {
    const value = midiElementValue("effect", effectId);
    return `<option value="${escapeHtml(value)}" ${selectedValue === value ? "selected" : ""}>${escapeHtml(effectLabel(effectId))}</option>`;
  }).join("");

  return `
    ${nodeOptions ? `<optgroup label="Operators">${nodeOptions}</optgroup>` : ""}
    ${linkOptions ? `<optgroup label="Links">${linkOptions}</optgroup>` : ""}
    <optgroup label="Audio Out">${effectOptions}</optgroup>
  `;
}

function renderMidiParameterOptions(targetType, targetId, selectedParameter) {
  return midiParameterDefinitions(targetType, targetId).map((definition) => (
    `<option value="${escapeHtml(definition.id)}" ${selectedParameter === definition.id ? "selected" : ""}>${escapeHtml(definition.label)}</option>`
  )).join("");
}

function midiBindingNumberStep(definition) {
  if (!definition || definition.type !== "number") return 1;
  return definition.max <= 1 ? 0.001 : definition.max >= 100 ? 1 : 0.01;
}

function midiCurveLabel(curve) {
  const labels = {
    linear: "Linear",
    logarithmic: "Logarithmic",
    exponential: "Exponential",
  };
  return labels[curve] || curve;
}

function renderRecentMidiCcItems() {
  const entries = recentMidiCcEntries();
  if (!entries.length) {
    return `<span class="recent-midi-empty">No recent CC movement</span>`;
  }

  return entries.map((entry) => `
    <span class="recent-midi-item">
      <span>CC ${entry.cc}</span>
      <span>${entry.value}</span>
    </span>
  `).join("");
}

function openMidiBindingModal(bindingId = null, preset = null) {
  const existing = state.midiBindings.find((binding) => binding.id === bindingId);
  const defaultTarget = existing
    || preset
    || (state.nodes[0] ? { targetType: "node", targetId: state.nodes[0].id, parameter: "wave", cc: 1 } : null)
    || (state.links[0] ? { targetType: "link", targetId: state.links[0].id, parameter: "amount", cc: 1 } : null)
    || { targetType: "effect", targetId: "chorus", parameter: "mix", cc: 1 };
  if (!defaultTarget) return;

  const selectedElementValue = midiElementValue(defaultTarget.targetType, defaultTarget.targetId);
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.innerHTML = `
    <div class="modal-stack">
      <form class="modal" id="midiBindingForm">
        <h2>${existing ? "Edit MIDI binding" : "New MIDI binding"}</h2>
        <div class="field">
          <label for="midiBindingElement">Element</label>
          <select id="midiBindingElement">${renderMidiElementOptions(selectedElementValue)}</select>
        </div>
        <div class="field">
          <label for="midiBindingParameter">Parameter</label>
          <select id="midiBindingParameter"></select>
        </div>
        <div class="midi-range-row">
          <div class="field">
            <label for="midiBindingMin">Min</label>
            <input id="midiBindingMin" type="number">
          </div>
          <div class="field">
            <label for="midiBindingMax">Max</label>
            <input id="midiBindingMax" type="number">
          </div>
          <div class="field">
            <label for="midiBindingCurve">Curve</label>
            <select id="midiBindingCurve">
              ${MIDI_CC_CURVES.map((curve) => `<option value="${curve}">${midiCurveLabel(curve)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="field">
          <label for="midiBindingCc">CC number</label>
          <input id="midiBindingCc" type="number" min="0" max="127" step="1" value="${existing?.cc ?? 1}">
        </div>
        <div class="modal-actions">
          ${existing ? `<button class="text-button danger" type="button" id="removeMidiBindingButton">Remove</button>` : ""}
          <button class="text-button" type="button" id="cancelMidiBindingButton">Cancel</button>
          <button class="text-button primary" type="submit">Save</button>
        </div>
      </form>
      <div class="recent-midi-cc" id="recentMidiCcList" aria-live="polite">
        ${renderRecentMidiCcItems()}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("#midiBindingForm");
  const elementSelect = overlay.querySelector("#midiBindingElement");
  const parameterSelect = overlay.querySelector("#midiBindingParameter");
  const minInput = overlay.querySelector("#midiBindingMin");
  const maxInput = overlay.querySelector("#midiBindingMax");
  const curveSelect = overlay.querySelector("#midiBindingCurve");
  const ccInput = overlay.querySelector("#midiBindingCc");
  const recentList = overlay.querySelector("#recentMidiCcList");
  const learnSession = existing ? null : { input: ccInput };
  let cleanupRecentTimer = null;
  if (learnSession) {
    pendingMidiCcLearn = learnSession;
  }
  const renderRecentList = () => {
    pruneRecentMidiCc();
    if (recentList.isConnected) {
      recentList.innerHTML = renderRecentMidiCcItems();
    }
  };
  recentMidiCcListeners.add(renderRecentList);
  cleanupRecentTimer = setInterval(renderRecentList, 250);
  const close = () => {
    if (pendingMidiCcLearn === learnSession) {
      pendingMidiCcLearn = null;
    }
    recentMidiCcListeners.delete(renderRecentList);
    clearInterval(cleanupRecentTimer);
    overlay.remove();
  };
  const currentDefinition = () => {
    const { targetType, targetId } = parseMidiElementValue(elementSelect.value);
    return midiParameterDefinitions(targetType, targetId)
      .find((definition) => definition.id === parameterSelect.value);
  };
  const syncRangeInputs = (preserveCurrent = false) => {
    const definition = currentDefinition();
    const isNumber = definition?.type === "number";
    minInput.disabled = !isNumber;
    maxInput.disabled = !isNumber;
    curveSelect.disabled = !isNumber;
    minInput.required = isNumber;
    maxInput.required = isNumber;
    minInput.placeholder = isNumber ? String(definition.min) : "N/A";
    maxInput.placeholder = isNumber ? String(definition.max) : "N/A";
    minInput.step = String(midiBindingNumberStep(definition));
    maxInput.step = String(midiBindingNumberStep(definition));
    minInput.min = isNumber ? String(definition.min) : "";
    minInput.max = isNumber ? String(definition.max) : "";
    maxInput.min = isNumber ? String(definition.min) : "";
    maxInput.max = isNumber ? String(definition.max) : "";
    if (!isNumber) {
      minInput.value = "";
      maxInput.value = "";
      curveSelect.value = "linear";
      return;
    }
    if (preserveCurrent && minInput.value !== "" && maxInput.value !== "") return;
    const range = existing
      && existing.targetType === parseMidiElementValue(elementSelect.value).targetType
      && existing.targetId === parseMidiElementValue(elementSelect.value).targetId
      && existing.parameter === parameterSelect.value
      ? midiBindingRange(existing, definition)
      : { min: definition.min, max: definition.max };
    minInput.value = String(range.min);
    maxInput.value = String(range.max);
    curveSelect.value = existing
      && existing.targetType === parseMidiElementValue(elementSelect.value).targetType
      && existing.targetId === parseMidiElementValue(elementSelect.value).targetId
      && existing.parameter === parameterSelect.value
      && MIDI_CC_CURVES.includes(existing.curve)
      ? existing.curve
      : "linear";
  };
  const syncParameterOptions = (preferredParameter = "") => {
    const { targetType, targetId } = parseMidiElementValue(elementSelect.value);
    parameterSelect.innerHTML = renderMidiParameterOptions(targetType, targetId, preferredParameter);
    syncRangeInputs();
  };

  syncParameterOptions(defaultTarget.parameter);
  if (!parameterSelect.value) syncParameterOptions();
  elementSelect.addEventListener("change", () => syncParameterOptions());
  parameterSelect.addEventListener("change", () => syncRangeInputs());
  overlay.querySelector("#cancelMidiBindingButton").addEventListener("click", close);
  overlay.querySelector("#removeMidiBindingButton")?.addEventListener("click", () => {
    state.midiBindings = state.midiBindings.filter((binding) => binding.id !== existing.id);
    close();
    renderPanel();
    savePatch();
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const { targetType, targetId } = parseMidiElementValue(elementSelect.value);
    const parameter = parameterSelect.value;
    const cc = clamp(Math.round(Number(ccInput.value)), 0, 127);
    const definition = midiParameterDefinitions(targetType, targetId)
      .find((item) => item.id === parameter);
    const minValue = Number(minInput.value);
    const maxValue = Number(maxInput.value);
    const range = definition?.type === "number"
      ? {
          min: Number.isFinite(minValue) ? clamp(minValue, definition.min, definition.max) : definition.min,
          max: Number.isFinite(maxValue) ? clamp(maxValue, definition.min, definition.max) : definition.max,
          curve: MIDI_CC_CURVES.includes(curveSelect.value) ? curveSelect.value : "linear",
        }
      : {};
    const binding = {
      id: existing?.id || midiBindingUid(),
      targetType,
      targetId,
      parameter,
      cc: Number.isFinite(cc) ? cc : 0,
      ...range,
    };

    if (existing) {
      Object.assign(existing, binding);
      if (definition?.type !== "number") {
        delete existing.min;
        delete existing.max;
        delete existing.curve;
      }
    } else {
      state.midiBindings.push(binding);
    }

    close();
    renderPanel();
    savePatch();
  });
  ccInput.focus();
  ccInput.select();
}

function renderEmptyPanel() {
  const midiChannelOptions = [
    `<option value="all" ${state.midiChannel === "all" ? "selected" : ""}>All channels</option>`,
    ...Array.from({ length: 16 }, (_, index) => {
      const channel = String(index + 1);
      return `<option value="${channel}" ${state.midiChannel === channel ? "selected" : ""}>Channel ${channel}</option>`;
    }),
  ].join("");
  const inputs = midiInputs();
  const hasSelectedInput = state.midiInputId === "all" || inputs.some((input) => input.id === state.midiInputId);
  const midiInputOptions = [
    `<option value="all" ${state.midiInputId === "all" ? "selected" : ""}>All inputs</option>`,
    ...inputs.map((input) => (
      `<option value="${escapeHtml(input.id)}" ${state.midiInputId === input.id ? "selected" : ""}>${escapeHtml(input.name || "MIDI input")}</option>`
    )),
    ...(!hasSelectedInput ? [`<option value="${escapeHtml(state.midiInputId)}" selected>Unavailable input</option>`] : []),
  ].join("");

  panel.innerHTML = `
    <div class="panel-empty">
      <h1>Patch</h1>
      <p class="panel-subtitle">File and MIDI settings</p>
      <div class="field">
        <label for="patchName">Name</label>
        <input id="patchName" type="text" value="${escapeHtml(state.patchName)}" autocomplete="off">
      </div>
      <div class="panel-actions">
        <button class="text-button" id="newPatchButton" type="button">New</button>
        <button class="text-button" id="savePatchButton" type="button">Save</button>
        <button class="text-button" id="loadPatchButton" type="button">Load</button>
        <input class="visually-hidden" id="loadPatchInput" type="file" accept=".yaml,.yml,.json,application/x-yaml,application/json">
      </div>
      <div class="field">
        <label for="maxVoices">Max voices</label>
        <div class="field-row">
          <input id="maxVoicesRange" type="range" min="${MIN_MAX_VOICES}" max="${MAX_MAX_VOICES}" step="1" value="${state.maxVoices}">
          <input id="maxVoices" type="number" min="${MIN_MAX_VOICES}" max="${MAX_MAX_VOICES}" step="1" value="${state.maxVoices}">
        </div>
      </div>
      <div class="field">
        <label for="midiInput">MIDI input</label>
        <select id="midiInput">${midiInputOptions}</select>
      </div>
      <div class="field">
        <label for="midiChannel">Receive channel</label>
        <select id="midiChannel">${midiChannelOptions}</select>
      </div>
      ${renderMidiBindingsSection()}
    </div>
  `;

  panel.querySelector("#patchName").addEventListener("input", (event) => {
    state.patchName = event.target.value;
    savePatch();
  });
  panel.querySelector("#patchName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  });
  bindNumberPair("maxVoices", "maxVoicesRange", MIN_MAX_VOICES, MAX_MAX_VOICES, (value) => {
    state.maxVoices = Math.round(value);
    sendGraph();
    savePatch();
  });
  panel.querySelector("#savePatchButton").addEventListener("click", downloadPatch);
  panel.querySelector("#newPatchButton").addEventListener("click", newPatch);
  panel.querySelector("#loadPatchButton").addEventListener("click", () => {
    panel.querySelector("#loadPatchInput").click();
  });
  panel.querySelector("#loadPatchInput").addEventListener("change", (event) => {
    loadPatchFile(event.target.files?.[0]);
  });
  panel.querySelector("#midiInput").addEventListener("change", (event) => {
    state.midiInputId = event.target.value;
    synthNode?.port.postMessage({ type: "panic" });
    pressedKeys.clear();
    updateMidiStatus();
    savePatch();
  });
  panel.querySelector("#midiChannel").addEventListener("change", (event) => {
    state.midiChannel = event.target.value;
    synthNode?.port.postMessage({ type: "panic" });
    pressedKeys.clear();
    updateMidiStatus();
    savePatch();
  });
  attachMidiBindingEvents();
}

function select(type, id) {
  state.selected = { type, id };
  render();
}

function render() {
  renderNodes();
  renderWires();
  renderAudioOut();
  renderPanel();
}

function addNode(position = null) {
  const rect = stage.getBoundingClientRect();
  const node = {
    id: uid("op"),
    name: alphaName(nodeCounter - 2),
    x: position ? clamp(position.x, 90, rect.width - 90) : rect.width / 2 + (Math.random() - 0.5) * 160,
    y: position ? clamp(position.y, 96, rect.height - 126) : Math.max(128, rect.height / 2 + (Math.random() - 0.5) * 120),
    wave: "sine",
    frequencyMode: "ratio",
    ratio: 1,
    frequency: 440,
    speed: 8,
  };
  state.nodes.push(node);
  select("node", node.id);
  sendGraph();
  savePatch();
}

function removeNode(id) {
  removeNodes([id]);
}

function pruneDanglingLinkTargets() {
  let changed = true;
  while (changed) {
    changed = false;
    const linkIds = new Set(state.links.map((link) => link.id));
    const nextLinks = state.links.filter((link) => (
      nodeById(link.from)
        && (nodeById(link.to) || link.to === "audio" || (linkIds.has(link.to) && link.to !== link.id))
    ));
    changed = nextLinks.length !== state.links.length;
    state.links = nextLinks;
  }
}

function removeNodes(ids) {
  const idSet = new Set(ids);
  state.nodes = state.nodes.filter((node) => !idSet.has(node.id));
  state.links = state.links.filter((link) => !idSet.has(link.from) && !idSet.has(link.to));
  pruneDanglingLinkTargets();
  pruneMidiBindings();
  state.selected = { type: null, id: null };
  render();
  sendGraph();
  reconcileAudioInput();
  savePatch();
}

function removeLink(id) {
  state.links = state.links.filter((link) => link.id !== id);
  pruneDanglingLinkTargets();
  pruneMidiBindings();
  state.selected = { type: null, id: null };
  render();
  sendGraph();
  savePatch();
}

function upsertLink(from, to) {
  const existing = state.links.find((link) => link.from === from && link.to === to);
  if (existing) {
    select("link", existing.id);
    return;
  }

  const targetLink = linkById(to);
  const link = {
    id: uid("link"),
    from,
    to,
    amount: 0,
    delay: 0,
    noise: 0,
    pan: 0,
    velocitySensitivity: to === "audio" ? 1 : 0,
    modulationTarget: to === "audio" ? "amplitude" : targetLink ? "amplitude" : "phase",
    drone: false,
    filter: { ...DEFAULT_LINK_FILTER },
    envelope: to === "audio"
      ? { delay: 0, attack: 0.01, decay: 0.18, sustain: 0.78, release: 0.32 }
      : { delay: 0, attack: 0.03, decay: 0.16, sustain: 0.65, release: 0.26 },
  };
  state.links.push(link);
  select("link", link.id);
  sendGraph();
  savePatch();
}

function onNodePointerDown(event) {
  const anchor = event.target.closest("[data-anchor]");
  const nodeElement = event.currentTarget;
  const nodeId = nodeElement.dataset.nodeId;

  event.preventDefault();
  ensureAudio();

  if (anchor?.dataset.anchor === "output") {
    event.stopPropagation();
    linkDrag = {
      from: nodeId,
      to: stagePoint(event.clientX, event.clientY),
    };
    window.addEventListener("pointermove", onLinkPointerMove);
    window.addEventListener("pointerup", onLinkPointerUp, { once: true });
    renderWires();
    return;
  }

  if (anchor?.dataset.anchor === "input") {
    return;
  }

  if (event.shiftKey || event.metaKey) {
    event.stopPropagation();
    addNodeToSelection(nodeId);
    return;
  }

  const start = stagePoint(event.clientX, event.clientY);
  const sourceIds = isNodeSelected(nodeId) ? selectedNodeIds() : [nodeId];
  const ids = event.altKey ? duplicateNodes(sourceIds).copies.map((node) => node.id) : sourceIds;
  dragState = {
    nodes: ids.map((id) => {
      const node = nodeById(id);
      return {
        id,
        offsetX: start.x - node.x,
        offsetY: start.y - node.y,
      };
    }),
  };
  window.addEventListener("pointermove", onNodePointerMove);
  window.addEventListener("pointerup", onNodePointerUp, { once: true });
  if (!event.altKey && !isNodeSelected(nodeId)) {
    select("node", nodeId);
  }
}

function onNodePointerMove(event) {
  if (!dragState) return;
  const point = stagePoint(event.clientX, event.clientY);
  const rect = stage.getBoundingClientRect();
  for (const item of dragState.nodes) {
    const node = nodeById(item.id);
    if (!node) continue;
    node.x = clamp(point.x - item.offsetX, 90, rect.width - 90);
    node.y = clamp(point.y - item.offsetY, 96, rect.height - 126);
  }
  scheduleNodesAndWiresRender();
}

function onNodePointerUp() {
  if (dragState) {
    savePatch();
  }
  dragState = null;
  window.removeEventListener("pointermove", onNodePointerMove);
}

function onLinkPointerMove(event) {
  if (!linkDrag) return;
  linkDrag.to = stagePoint(event.clientX, event.clientY);
  scheduleWiresRender();
}

function onLinkPointerUp(event) {
  if (!linkDrag) return;
  const targets = document.elementsFromPoint(event.clientX, event.clientY);
  const target = targets[0];
  const inputAnchor = target?.closest?.(".anchor.input");
  const audioAnchor = target?.closest?.(".audio-anchor, .audio-out");
  const linkAnchor = targets
    .map((item) => item.closest?.(".link-anchor.input"))
    .find(Boolean);

  if (inputAnchor?.dataset.nodeId) {
    upsertLink(linkDrag.from, inputAnchor.dataset.nodeId);
  } else if (linkAnchor?.dataset.linkId) {
    upsertLink(linkDrag.from, linkAnchor.dataset.linkId);
  } else if (audioAnchor) {
    upsertLink(linkDrag.from, "audio");
  }

  linkDrag = null;
  window.removeEventListener("pointermove", onLinkPointerMove);
  renderWires();
}

function onStageResize() {
  scheduleWiresRender();
}

function isEmptyCanvasTarget(target) {
  return target === stage || target === nodeLayer || target === wireLayer;
}

function onStagePointerDown(event) {
  if (event.button !== 0 || !isEmptyCanvasTarget(event.target)) return;

  const point = stagePoint(event.clientX, event.clientY);
  marqueeState = {
    active: true,
    moved: false,
    start: point,
    current: point,
  };
  renderSelectionRect();
  window.addEventListener("pointermove", onMarqueePointerMove);
  window.addEventListener("pointerup", onMarqueePointerUp, { once: true });
}

function onMarqueePointerMove(event) {
  if (!marqueeState) return;

  marqueeState.current = stagePoint(event.clientX, event.clientY);
  const bounds = selectionBounds(marqueeState.start, marqueeState.current);
  marqueeState.moved = bounds.width > 4 || bounds.height > 4;
  renderSelectionRect();

  if (marqueeState.moved) {
    const ids = nodesInsideSelection();
    if (ids.length > 1) {
      state.selected = { type: "nodes", ids };
    } else if (ids.length === 1) {
      state.selected = { type: "node", id: ids[0] };
    } else {
      state.selected = { type: null, id: null };
    }
    renderNodes();
    renderPanel();
  }
}

function onMarqueePointerUp() {
  if (!marqueeState) return;

  const shouldSelect = marqueeState.moved;
  const ids = shouldSelect ? nodesInsideSelection() : [];
  marqueeState = null;
  renderSelectionRect();
  window.removeEventListener("pointermove", onMarqueePointerMove);

  if (shouldSelect) {
    suppressNextStageClick = true;
    selectNodes(ids);
  }
}

addNodeButton.addEventListener("click", () => {
  ensureAudio();
  addNode();
});

recordButton.addEventListener("click", toggleRecording);

fineSliderButton?.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || touchFineSliderPointerId !== null) return;
  event.preventDefault();
  event.stopPropagation();
  touchFineSliderPointerId = event.pointerId;
  fineSliderButton.setPointerCapture?.(event.pointerId);
  syncFineSliderButton();
});

fineSliderButton?.addEventListener("pointerup", (event) => {
  event.preventDefault();
  event.stopPropagation();
  releaseTouchFineSlider(event.pointerId);
});

fineSliderButton?.addEventListener("pointercancel", (event) => {
  event.stopPropagation();
  releaseTouchFineSlider(event.pointerId);
});

fineSliderButton?.addEventListener("lostpointercapture", () => {
  touchFineSliderPointerId = null;
  syncFineSliderButton();
});

fineSliderButton?.addEventListener("click", (event) => {
  event.stopPropagation();
});

fineSliderButton?.addEventListener("keydown", (event) => {
  if (event.key !== " " && event.key !== "Enter") return;
  event.preventDefault();
  setKeyboardFineSliderActive(true);
});

fineSliderButton?.addEventListener("keyup", (event) => {
  if (event.key !== " " && event.key !== "Enter") return;
  event.preventDefault();
  setKeyboardFineSliderActive(false);
});

fineSliderButton?.addEventListener("blur", () => {
  setKeyboardFineSliderActive(false);
});

audioStatus.addEventListener("click", () => {
  if (audioStatus.disabled || !audioContext || !synthNode) return;
  audioMuted = !audioMuted;
  syncOutputMute();
  updateAudioReadyButton();
});

stage.addEventListener("pointerdown", onStagePointerDown);

stage.addEventListener("dblclick", (event) => {
  if (!isEmptyCanvasTarget(event.target)) return;
  ensureAudio();
  addNode(stagePoint(event.clientX, event.clientY));
});

stage.addEventListener("click", (event) => {
  if (suppressNextStageClick) {
    suppressNextStageClick = false;
    return;
  }
  if (event.target === stage || event.target === nodeLayer || event.target === wireLayer) {
    state.selected = { type: null, id: null };
    render();
  }
});

audioOut.addEventListener("click", (event) => {
  event.stopPropagation();
  select("audio", "audio");
});

window.addEventListener("resize", onStageResize);

window.addEventListener("keydown", (event) => {
  if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName)) return;
  if ((event.key === "Backspace" || event.key === "Delete") && state.selected.id) {
    event.preventDefault();
    if (state.selected.type === "node") {
      removeNode(state.selected.id);
    } else if (state.selected.type === "link") {
      removeLink(state.selected.id);
    }
    return;
  }

  if ((event.key === "Backspace" || event.key === "Delete") && state.selected.type === "nodes") {
    event.preventDefault();
    removeNodes(selectedNodeIds());
    return;
  }

  const note = keyMap.get(event.key);
  if (note === undefined || pressedKeys.has(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
  pressedKeys.add(event.key);
  noteOn(note, 0.82);
});

window.addEventListener("keyup", (event) => {
  const note = keyMap.get(event.key);
  if (note === undefined) return;
  pressedKeys.delete(event.key);
  noteOff(note);
});

render();
setupMidi();
requestAnimationFrame(showAudioEnableModal);
