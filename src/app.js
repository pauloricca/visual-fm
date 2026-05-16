import {
  DEFAULT_AUDIO_DEVICE_ID,
  DEFAULT_LINK_FILTER,
  DEFAULT_LINK_FOLLOWER,
  FREQUENCY_MODES,
  LINK_FILTER_TYPES,
  LINK_INPUT_T,
  LINK_MODULATION_TARGETS,
  LINK_SIGNAL_MODES,
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
import { parsePatchFile, patchFileText } from "./patch-format.js";
import {
  linkHasPan,
  normalizeDefaultPatch,
  normalizeFrequencyMode,
  normalizePatch,
  normalizeSignalMode,
} from "./patch-normalize.js";
import { audioBufferToWav, mediaRecorderOptions } from "./recording.js";
import {
  alphaName,
  clamp,
  clonePatch,
  escapeHtml,
  isPitchedWave,
  isSpeedWave,
} from "./utils.js";

const stage = document.querySelector("#stage");
const nodeLayer = document.querySelector("#nodeLayer");
const wireLayer = document.querySelector("#wireLayer");
const panel = document.querySelector("#panel");
const appTitle = document.querySelector("#appTitle");
const addNodeButton = document.querySelector("#addNodeButton");
const recordButton = document.querySelector("#recordButton");
const audioOut = document.querySelector("#audioOut");
const audioStatus = document.querySelector("#audioStatus");
const midiStatus = document.querySelector("#midiStatus");
const selectionRect = document.querySelector("#selectionRect");
const fineSliderButton = document.querySelector("#fineSliderButton");
const AUDIO_BACKEND_STORAGE_KEY = "visual-fm.audioBackend";
const AUDIO_BACKENDS = {
  js: {
    label: "JS AudioWorklet",
    moduleUrl: "./src/audio-worklet.js?v=link-signal-follower-meter-7",
    processorName: "visual-fm-engine",
  },
  wasm: {
    label: "WASM spike",
    moduleUrl: "./src/audio-worklet-wasm.js?v=wasm-engine-spike-7",
    processorName: "visual-fm-wasm-engine",
    processorOptions: async () => {
      const wasmUrl = new URL("./src/wasm/visual-fm-kernel.wasm?v=wasm-engine-spike-7", window.location.href).href;
      const response = await fetch(wasmUrl);
      if (!response.ok) {
        throw new Error(`Could not fetch WASM kernel (${response.status}).`);
      }
      return {
        wasmUrl,
        wasmBytes: await response.arrayBuffer(),
      };
    },
  },
};
const LINK_PARAM_GRAPH_SYNC_DELAY_MS = 180;
const LINK_AMOUNT_SLIDER_MAX = 8;
const LINK_AMOUNT_INPUT_MAX = 32;
const FINE_SLIDER_SCALE = 0.1;
const VALUE_SLIDER_DRAG_THRESHOLD_PX = 4;

function audioContextConstructor() {
  return window.AudioContext || window.webkitAudioContext;
}

function normalizeAudioBackend(value) {
  return value === "wasm" ? "wasm" : "js";
}

function loadAudioBackend() {
  const queryBackend = new URLSearchParams(window.location.search).get("engine");
  if (queryBackend) return normalizeAudioBackend(queryBackend);
  try {
    return normalizeAudioBackend(localStorage.getItem(AUDIO_BACKEND_STORAGE_KEY));
  } catch {
    return "js";
  }
}

const state = {
  ...loadPatch(),
  selected: { type: null, id: null },
};

let audioContext = null;
let synthNode = null;
let outputGainNode = null;
let audioInputStream = null;
let audioInputSource = null;
let audioOutputSinkDestination = null;
let audioOutputSinkElement = null;
let audioOutputRouteError = "";
let recorderDestination = null;
let audioReadyPromise = null;
let mediaRecorder = null;
let recordingChunks = [];
let recordingStartedAt = null;
let recordingStarting = false;
let recordingSavedTimer = null;
let audioMuted = false;
let audioBackend = loadAudioBackend();
let audioBackendStatus = audioBackend === "wasm" ? { backend: "wasm", ready: false } : { backend: "js", ready: true };
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
let pendingFullNodesRender = false;
let pendingWiresFrame = null;
let pendingMidiCcLearn = null;
let pendingMidiCcSmoothingFrame = null;
const midiCcSmoothing = new Map();
const pendingMovedNodeIds = new Set();
const recentMidiCc = new Map();
const recentMidiCcListeners = new Set();
const midiBindingFlashTimers = new Map();
const midiTargetFlashTimers = new Map();
const linkMeterLevels = new Map();
let pendingLinkMeterFrame = null;
let suppressNextStageClick = false;
let preserveSelectionAfterValueEditClick = false;
let touchFineSliderPointerId = null;
let keyboardFineSliderActive = false;
let availableAudioDevices = { inputs: [], outputs: [] };
let patchLibrary = null;

syncCounters();
pruneMidiBindings();
if (state.selected.id && !nodeById(state.selected.id)) {
  state.selected = { type: null, id: null };
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
    audioInputDeviceId: state.audioInputDeviceId,
    audioOutputDeviceId: state.audioOutputDeviceId,
    linkSignalGradientMeters: Boolean(state.linkSignalGradientMeters),
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
    ...(node.wave === "audio-input" ? [{
      id: "audioInputGain",
      label: "Input gain",
      type: "number",
      min: 0,
      max: 4,
      get: () => node.audioInputGain ?? 1,
      set: (value) => {
        node.audioInputGain = value;
      },
    }] : []),
  ];

  return definitions;
}

function linkParameterDefinitions(link) {
  const targetNameLabel = targetName(link.to);
  const modulationTargets = modulationTargetsForLink(link);
  const amountMax = link.modulationTarget === "mix" ? 1 : LINK_AMOUNT_INPUT_MAX;
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
      label: "Envelope bypass",
      type: "boolean",
      get: () => link.drone,
      set: (value) => {
        link.drone = value;
        if (value) ensureAudio();
      },
    },
    {
      id: "filter.enabled",
      label: "Filter",
      type: "boolean",
      get: () => link.filter.type !== "none",
      set: (value) => {
        link.filter.type = value ? (link.filter.type === "none" ? "lowpass" : link.filter.type) : "none";
      },
    },
    {
      id: "signalMode",
      label: "Signal",
      type: "choice",
      options: LINK_SIGNAL_MODES.map((value) => ({ value, label: signalModeLabel(value) })),
      get: () => link.signalMode,
      set: (value) => {
        link.signalMode = normalizeSignalMode(value);
      },
    },
    {
      id: "follower.attack",
      label: "Follower attack",
      type: "number",
      min: 0.001,
      max: 2,
      get: () => link.follower?.attack ?? DEFAULT_LINK_FOLLOWER.attack,
      set: (value) => {
        link.follower = { ...(link.follower || DEFAULT_LINK_FOLLOWER), attack: value };
      },
    },
    {
      id: "follower.release",
      label: "Follower release",
      type: "number",
      min: 0.001,
      max: 4,
      get: () => link.follower?.release ?? DEFAULT_LINK_FOLLOWER.release,
      set: (value) => {
        link.follower = { ...(link.follower || DEFAULT_LINK_FOLLOWER), release: value };
      },
    },
    {
      id: "filter.type",
      label: "Filter type",
      type: "choice",
      options: LINK_FILTER_TYPES
        .filter((value) => value !== "none")
        .map((value) => ({ value, label: filterTypeLabel(value) })),
      get: () => link.filter.type,
      set: (value) => {
        link.filter.type = value === "none" ? "lowpass" : value;
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
  if (input) syncValueSliderNumber(input, range, value);
  if (range) {
    range.value = String(value);
    syncValueSliderProgress(range, Number(range.min), Number(range.max));
  }
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
    if (node && smoothing.parameter === "audioInputGain") {
      setPanelNumberPair("audioInputGain", "audioInputGainRange", value);
    }
    return;
  }

  const linkControlIds = {
    amount: "amount",
    pan: "pan",
    velocitySensitivity: "velocitySensitivity",
    noise: "noise",
    delay: "linkDelay",
    "follower.attack": "followerAttack",
    "follower.release": "followerRelease",
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

function stagePointFromRect(clientX, clientY, rect) {
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function stagePoint(clientX, clientY) {
  return stagePointFromRect(clientX, clientY, stage.getBoundingClientRect());
}

function captureStagePointer(pointerId) {
  try {
    stage.setPointerCapture?.(pointerId);
  } catch {
    // Pointer capture can fail if the browser has already cancelled the contact.
  }
}

function releaseStagePointer(pointerId) {
  try {
    if (!stage.hasPointerCapture || stage.hasPointerCapture(pointerId)) {
      stage.releasePointerCapture?.(pointerId);
    }
  } catch {
    // The pointer may already be gone after a touch cancellation.
  }
}

function isPrimaryDragPointer(event) {
  return event.isPrimary || !event.pointerType || event.pointerType === "mouse";
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

function linkEndpointPoint(to, visited = new Set(), context = null) {
  if (to === "audio") {
    if (context && !context.audioPoint) context.audioPoint = audioInputPoint();
    return context?.audioPoint || audioInputPoint();
  }
  if (nodeById(to)) return nodeInputPoint(to);
  if (linkById(to)) return linkInputPoint(to, visited, context);
  return null;
}

function linkInputPoint(id, visited = new Set(), context = null) {
  if (visited.has(id)) return null;
  const link = linkById(id);
  if (!link || !nodeById(link.from)) return null;

  visited.add(id);
  const to = linkEndpointPoint(link.to, visited, context);
  visited.delete(id);
  if (!to) return null;

  if (link.from === link.to) return feedbackMidpoint(link.from);
  return bezierPoint(nodeOutputPoint(link.from), to, LINK_INPUT_T);
}

function linkGeometry(link, visited = new Set(), context = null) {
  if (!link || !nodeById(link.from) || visited.has(link.id)) return null;
  visited.add(link.id);
  const from = nodeOutputPoint(link.from);
  const to = linkEndpointPoint(link.to, visited, context);
  visited.delete(link.id);
  if (!to) return null;

  const path = link.from === link.to ? feedbackPath(link.from) : bezierPath(from, to);
  const midpoint = link.from === link.to ? feedbackMidpoint(link.from) : bezierPoint(from, to, LINK_INPUT_T);
  return { from, to, path, midpoint };
}

function graphPayload() {
  return {
    nodes: state.nodes.map(({ id, wave, frequencyMode, ratio, frequency, speed, audioInputGain }) => ({
      id,
      wave,
      frequencyMode,
      ratio,
      frequency,
      speed,
      audioInputGain,
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
      signalMode: normalizeSignalMode(link.signalMode),
      follower: { ...(link.follower || DEFAULT_LINK_FOLLOWER) },
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

function selectedAudioDeviceId(kind) {
  const key = kind === "output" ? "audioOutputDeviceId" : "audioInputDeviceId";
  return state[key] || DEFAULT_AUDIO_DEVICE_ID;
}

function audioInputDevices() {
  return availableAudioDevices.inputs;
}

function audioOutputDevices() {
  return availableAudioDevices.outputs;
}

function audioDeviceLabel(device, fallback, index) {
  return device.label || `${fallback} ${index + 1}`;
}

function audioDeviceOptions(devices, selectedId, defaultLabel, fallbackLabel, unavailableLabel) {
  const realDevices = devices.filter((device) => device.deviceId && device.deviceId !== DEFAULT_AUDIO_DEVICE_ID);
  const hasSelectedDevice = selectedId === DEFAULT_AUDIO_DEVICE_ID
    || realDevices.some((device) => device.deviceId === selectedId);
  return [
    `<option value="${DEFAULT_AUDIO_DEVICE_ID}" ${selectedId === DEFAULT_AUDIO_DEVICE_ID ? "selected" : ""}>${defaultLabel}</option>`,
    ...realDevices.map((device, index) => (
      `<option value="${escapeHtml(device.deviceId)}" ${selectedId === device.deviceId ? "selected" : ""}>${escapeHtml(audioDeviceLabel(device, fallbackLabel, index))}</option>`
    )),
    ...(!hasSelectedDevice ? [`<option value="${escapeHtml(selectedId)}" selected>${unavailableLabel}</option>`] : []),
  ].join("");
}

async function refreshAudioDevices({ renderPatchPanel = false } = {}) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    availableAudioDevices = { inputs: [], outputs: [] };
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    availableAudioDevices = {
      inputs: devices.filter((device) => device.kind === "audioinput"),
      outputs: devices.filter((device) => device.kind === "audiooutput"),
    };
    if (renderPatchPanel && !state.selected.type) {
      renderPanel();
    }
  } catch {
    availableAudioDevices = { inputs: [], outputs: [] };
  }
}

function disconnectOutputRoutes() {
  if (!outputGainNode) return;
  try {
    outputGainNode.disconnect();
  } catch {
    // Disconnect can throw if no route exists yet.
  }
}

function connectOutputRoute(destination) {
  if (!outputGainNode || !destination) return;
  disconnectOutputRoutes();
  outputGainNode.connect(destination);
}

function stopOutputSinkElement() {
  if (!audioOutputSinkElement) return;
  audioOutputSinkElement.pause();
  audioOutputSinkElement.srcObject = null;
}

function ensureOutputSinkElement() {
  if (!audioOutputSinkDestination) {
    audioOutputSinkDestination = audioContext.createMediaStreamDestination();
  }
  if (!audioOutputSinkElement) {
    audioOutputSinkElement = document.createElement("audio");
    audioOutputSinkElement.autoplay = true;
    audioOutputSinkElement.playsInline = true;
  }
  if (audioOutputSinkElement.srcObject !== audioOutputSinkDestination.stream) {
    audioOutputSinkElement.srcObject = audioOutputSinkDestination.stream;
  }
}

async function syncAudioOutputDevice() {
  if (!audioContext || !outputGainNode) return true;

  const deviceId = selectedAudioDeviceId("output");
  const sinkId = deviceId === DEFAULT_AUDIO_DEVICE_ID ? "" : deviceId;

  if (typeof audioContext.setSinkId === "function") {
    try {
      await audioContext.setSinkId(sinkId);
      connectOutputRoute(audioContext.destination);
      stopOutputSinkElement();
      audioOutputRouteError = "";
      return true;
    } catch {
      connectOutputRoute(audioContext.destination);
      stopOutputSinkElement();
      audioOutputRouteError = "Audio output blocked";
      return false;
    }
  }

  if (!sinkId) {
    connectOutputRoute(audioContext.destination);
    stopOutputSinkElement();
    audioOutputRouteError = "";
    return true;
  }

  if (typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype) {
    try {
      ensureOutputSinkElement();
      await audioOutputSinkElement.setSinkId(sinkId);
      connectOutputRoute(audioOutputSinkDestination);
      await audioOutputSinkElement.play();
      audioOutputRouteError = "";
      return true;
    } catch {
      connectOutputRoute(audioContext.destination);
      audioOutputRouteError = "Audio output blocked";
      return false;
    }
  }

  connectOutputRoute(audioContext.destination);
  audioOutputRouteError = "Audio output unavailable";
  return false;
}

function sendLinkParam(id, parameter, value) {
  synthNode?.port.postMessage({
    type: "linkParam",
    payload: { id, parameter, value },
  });
  scheduleLinkParamGraphSync();
}

function scheduleLinkMeterPaint() {
  if (pendingLinkMeterFrame) return;
  pendingLinkMeterFrame = requestAnimationFrame(() => {
    pendingLinkMeterFrame = null;
    updateSelectedLinkMeter();
    if (state.linkSignalGradientMeters) updateWireSignalMeters();
  });
}

function handleWorkletMessage(event) {
  const { type, payload } = event.data || {};
  if (type === "backendStatus") {
    audioBackendStatus = payload || { backend: audioBackend, ready: false };
    updateAudioStatus();
    return;
  }
  if (type !== "linkMeters" || !Array.isArray(payload?.levels)) return;

  for (const [id, inputLevel, outputLevel, envelopeLevel] of payload.levels) {
    linkMeterLevels.set(id, {
      input: clamp(Number(inputLevel) || 0, 0, 1),
      output: clamp(Number(outputLevel) || 0, 0, 1),
      envelope: clamp(Number(envelopeLevel) || 0, 0, 1),
    });
  }
  scheduleLinkMeterPaint();
}

function updateSelectedLinkMeter() {
  const meter = panel.querySelector("[data-link-meter]");
  if (!meter) return;

  const linkId = meter.dataset.linkMeter;
  const levels = linkMeterLevels.get(linkId) || { input: 0, output: 0, envelope: 0 };
  const inputFill = meter.querySelector("[data-link-meter-fill='input']");
  const outputFill = meter.querySelector("[data-link-meter-fill='output']");
  const envelopeFill = panel.querySelector(`[data-envelope-meter="${CSS.escape(linkId)}"] [data-link-meter-fill='envelope']`);
  if (inputFill) inputFill.style.transform = `scaleY(${clamp(levels.input || 0, 0, 1)})`;
  if (outputFill) outputFill.style.transform = `scaleY(${clamp(levels.output || 0, 0, 1)})`;
  if (envelopeFill) envelopeFill.style.transform = `scaleY(${clamp(levels.envelope || 0, 0, 1)})`;
}

function wireMeterGradientId(linkId) {
  return `wire-signal-meter-${linkId}`;
}

function setWireFlowStopOpacity(stop, level, selected = false) {
  if (!stop) return;
  stop.setAttribute("stop-color", "#ffffff");
  stop.setAttribute("stop-opacity", String(clamp(level || 0, 0, 1) * (selected ? 1 : 0.72)));
}

function updateWireSignalMeter(link) {
  const gradient = wireLayer.querySelector(`#${CSS.escape(wireMeterGradientId(link.id))}`);
  if (!gradient) return;
  const levels = linkMeterLevels.get(link.id) || { input: 0, output: 0 };
  const selected = state.selected.type === "link" && state.selected.id === link.id;
  setWireFlowStopOpacity(gradient.querySelector("[data-wire-meter-stop='input']"), levels.input, selected);
  setWireFlowStopOpacity(gradient.querySelector("[data-wire-meter-stop='output']"), levels.output, selected);
  setWireFlowStopOpacity(gradient.querySelector("[data-wire-meter-stop='output-end']"), levels.output, selected);
}

function updateWireSignalMeters() {
  for (const link of state.links) updateWireSignalMeter(link);
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
  } else if (audioOutputRouteError) {
    setAudioStatusLabel(audioOutputRouteError);
  } else if (audioContext && synthNode && audioBackendStatus?.backend === "wasm" && audioBackendStatus.error) {
    setAudioStatusLabel("WASM audio failed");
  } else if (audioContext && synthNode && audioBackendStatus?.backend === "wasm" && !audioBackendStatus.ready) {
    setAudioStatusLabel("WASM loading");
  } else if (audioContext && synthNode) {
    updateAudioReadyButton();
  } else {
    setAudioStatusLabel("Audio idle");
  }
}

function positionNodeElement(element, node) {
  element.style.setProperty("--node-x", `${node.x}px`);
  element.style.setProperty("--node-y", `${node.y}px`);
}

function updateNodeElementPositions(ids) {
  for (const id of ids) {
    const node = nodeById(id);
    const escapedId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
    const element = nodeLayer.querySelector(`[data-node-id="${escapedId}"]`);
    if (node && element) positionNodeElement(element, node);
  }
}

function scheduleNodesAndWiresRender(ids = null) {
  if (ids) {
    for (const id of ids) pendingMovedNodeIds.add(id);
  } else {
    pendingFullNodesRender = true;
  }

  if (pendingNodesAndWiresFrame) return;
  pendingNodesAndWiresFrame = requestAnimationFrame(() => {
    pendingNodesAndWiresFrame = null;
    const movedIds = [...pendingMovedNodeIds];
    pendingMovedNodeIds.clear();
    if (pendingFullNodesRender) {
      renderNodes();
    } else {
      updateNodeElementPositions(movedIds);
    }
    pendingFullNodesRender = false;
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

function createAudioContext() {
  const AudioContextConstructor = audioContextConstructor();
  if (!AudioContextConstructor) {
    throw new Error("Web Audio is not supported in this browser.");
  }
  return new AudioContextConstructor();
}

async function resumeAudioContext() {
  if (!audioContext || audioContext.state === "running") return;
  await audioContext.resume();
}

function audioEnableErrorMessage(error) {
  if (!audioContextConstructor()) {
    return "This browser does not support Web Audio.";
  }
  if (audioContext && !audioContext.audioWorklet?.addModule) {
    if (!window.isSecureContext) {
      return "AudioWorklet needs HTTPS on iOS. Open this page from a secure URL.";
    }
    return "This browser does not support AudioWorklet.";
  }
  if (error?.name === "NotAllowedError") {
    return "Audio was blocked. Tap Enable audio again.";
  }
  return "Audio could not start. Tap Enable audio again.";
}

async function setupAudio() {
  if (!audioContext) {
    audioContext = createAudioContext();
  }

  await resumeAudioContext();

  if (!synthNode) {
    if (!audioContext.audioWorklet?.addModule) {
      throw new Error("AudioWorklet is not supported in this browser.");
    }
    const backend = AUDIO_BACKENDS[audioBackend] || AUDIO_BACKENDS.js;
    audioBackendStatus = audioBackend === "wasm"
      ? { backend: "wasm", ready: false }
      : { backend: "js", ready: true };
    await audioContext.audioWorklet.addModule(backend.moduleUrl);
    const processorOptions = await backend.processorOptions?.() || {};
    synthNode = new AudioWorkletNode(audioContext, backend.processorName, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      inputChannelCount: [2],
      outputChannelCount: [2],
      processorOptions,
    });
    outputGainNode = audioContext.createGain();
    syncOutputMute();
    synthNode.connect(outputGainNode);
    synthNode.port.onmessage = handleWorkletMessage;
    sendGraph({ immediate: true });
  }

  if (synthNode && !recorderDestination) {
    recorderDestination = audioContext.createMediaStreamDestination();
    synthNode.connect(recorderDestination);
  }

  await resumeAudioContext();
  await syncAudioOutputDevice();
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

  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  const deviceId = selectedAudioDeviceId("input");
  if (deviceId !== DEFAULT_AUDIO_DEVICE_ID) {
    audioConstraints.deviceId = { exact: deviceId };
  }

  audioInputStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  audioInputSource = audioContext.createMediaStreamSource(audioInputStream);
  audioInputSource.connect(synthNode);
  refreshAudioDevices({ renderPatchPanel: !state.selected.type });
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
      <p class="modal-error" id="audioEnableError" role="alert" hidden></p>
      <div class="modal-actions">
        <button class="text-button primary" id="enableAudioButton" type="button">Enable audio</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const enableButton = overlay.querySelector("#enableAudioButton");
  const errorMessage = overlay.querySelector("#audioEnableError");
  const enableButtonLabel = enableButton.textContent;
  let enabling = false;

  const handleEnableAudio = async () => {
    if (enabling) return;
    enabling = true;
    enableButton.disabled = true;
    enableButton.textContent = "Enabling...";
    errorMessage.hidden = true;
    try {
      await ensureAudio();
      overlay.remove();
    } catch (error) {
      console.error("Could not enable audio", error);
      const message = audioEnableErrorMessage(error);
      errorMessage.textContent = message;
      errorMessage.hidden = false;
      setAudioStatusLabel(message);
      enableButton.disabled = false;
      enableButton.textContent = enableButtonLabel;
      enabling = false;
    }
  };

  enableButton.addEventListener("pointerup", handleEnableAudio);
  enableButton.addEventListener("touchend", (event) => {
    event.preventDefault();
    handleEnableAudio();
  });
  enableButton.addEventListener("click", handleEnableAudio);
}

function setRecordingButtonState(isRecording) {
  if (isRecording) {
    clearTimeout(recordingSavedTimer);
    recordButton.classList.remove("saved");
  }
  recordButton.classList.toggle("recording", isRecording);
  recordButton.setAttribute("aria-label", isRecording ? "Stop recording" : "Start recording");
  recordButton.title = isRecording ? "Stop recording" : "Start recording";
}

function showRecordingSavedState() {
  clearTimeout(recordingSavedTimer);
  recordButton.classList.remove("recording");
  recordButton.classList.add("saved");
  recordButton.setAttribute("aria-label", "Recording saved");
  recordButton.title = "Recording saved";
  recordingSavedTimer = window.setTimeout(() => {
    recordButton.classList.remove("saved");
    recordButton.setAttribute("aria-label", "Start recording");
    recordButton.title = "Start recording";
    recordingSavedTimer = null;
  }, 1200);
}

async function saveRecordingToServer(wavBlob) {
  const response = await fetch("/api/recordings", {
    method: "POST",
    headers: {
      "content-type": "audio/wav",
      "x-recording-started-at": (recordingStartedAt || new Date()).toISOString(),
    },
    body: wavBlob,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Recording save failed (${response.status}).`);
  }
}

async function exportRecording() {
  const sourceBlob = new Blob(recordingChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  if (!sourceBlob.size) return;

  const arrayBuffer = await sourceBlob.arrayBuffer();
  const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  await saveRecordingToServer(audioBufferToWav(decoded));
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
      showRecordingSavedState();
    } catch (error) {
      alert(`Could not save recording: ${error.message}`);
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
    positionNodeElement(element, node);
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
  const geometryContext = {};
  const defs = state.linkSignalGradientMeters
    ? document.createElementNS("http://www.w3.org/2000/svg", "defs")
    : null;
  if (defs) wireLayer.appendChild(defs);

  for (const link of state.links) {
    const geometry = linkGeometry(link, new Set(), geometryContext);
    if (!geometry) continue;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const visible = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const flow = state.linkSignalGradientMeters
      ? document.createElementNS("http://www.w3.org/2000/svg", "path")
      : null;
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const anchor = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const anchorHit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const anchorDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");

    visible.setAttribute("d", geometry.path);
    visible.setAttribute("class", `wire ${link.to === "audio" ? "output" : ""} ${linkById(link.to) ? "link-mod" : ""} ${link.from === link.to ? "feedback" : ""} ${state.selected.type === "link" && state.selected.id === link.id ? "selected" : ""}`);
    if (defs) {
      const gradient = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
      const inputStop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      const outputStop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      const outputEndStop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      gradient.id = wireMeterGradientId(link.id);
      gradient.setAttribute("gradientUnits", "userSpaceOnUse");
      gradient.setAttribute("x1", geometry.from.x);
      gradient.setAttribute("y1", geometry.from.y);
      gradient.setAttribute("x2", geometry.to.x);
      gradient.setAttribute("y2", geometry.to.y);
      inputStop.setAttribute("offset", "0%");
      inputStop.setAttribute("stop-color", "#ffffff");
      inputStop.setAttribute("stop-opacity", "0");
      inputStop.dataset.wireMeterStop = "input";
      outputStop.setAttribute("offset", "25%");
      outputStop.setAttribute("stop-color", "#ffffff");
      outputStop.setAttribute("stop-opacity", "0");
      outputStop.dataset.wireMeterStop = "output";
      outputEndStop.setAttribute("offset", "100%");
      outputEndStop.setAttribute("stop-color", "#ffffff");
      outputEndStop.setAttribute("stop-opacity", "0");
      outputEndStop.dataset.wireMeterStop = "output-end";
      gradient.append(inputStop, outputStop, outputEndStop);
      defs.appendChild(gradient);
    }
    visible.dataset.midiTargetType = "link";
    visible.dataset.midiTargetId = link.id;

    if (flow) {
      flow.setAttribute("d", geometry.path);
      flow.setAttribute("class", `wire-flow ${link.to === "audio" ? "output" : ""} ${linkById(link.to) ? "link-mod" : ""} ${state.selected.type === "link" && state.selected.id === link.id ? "selected" : ""}`);
      flow.style.stroke = `url(#${wireMeterGradientId(link.id)})`;
    }

    hit.setAttribute("d", geometry.path);
    hit.setAttribute("class", "wire-hit");
    hit.dataset.linkId = link.id;

    anchor.setAttribute("class", `link-anchor input ${state.selected.type === "link" && state.selected.id === link.id ? "selected" : ""}`);
    anchor.dataset.linkId = link.id;
    anchor.dataset.midiTargetType = "link";
    anchor.dataset.midiTargetId = link.id;
    anchorHit.setAttribute("cx", geometry.midpoint.x);
    anchorHit.setAttribute("cy", geometry.midpoint.y);
    anchorHit.setAttribute("r", "34");
    anchorHit.setAttribute("class", "link-anchor-hit");
    anchorDot.setAttribute("cx", geometry.midpoint.x);
    anchorDot.setAttribute("cy", geometry.midpoint.y);
    anchorDot.setAttribute("r", "10");
    anchorDot.setAttribute("class", "link-anchor-dot");
    anchor.append(anchorHit, anchorDot);

    group.append(visible);
    if (flow) group.appendChild(flow);
    group.append(hit, anchor);
    wireLayer.appendChild(group);
    if (defs) updateWireSignalMeter(link);
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

function panelRemoveAction(label) {
  return `
    <div class="panel-remove-footer">
      <button class="panel-remove-action" type="button" aria-label="${escapeHtml(label)}">
        Remove
      </button>
    </div>
  `;
}

function attachPanelRemoveAction() {
  panel.querySelector(".panel-remove-action")?.addEventListener("click", (event) => {
    event.preventDefault();
    removeSelectedElements();
  });
}

function renderPanel() {
  const selection = state.selected;
  if (selection.type === "nodes") {
    const count = selectedNodeIds().length;
    panel.innerHTML = `
      <div class="panel-heading">
        <div>
          <h1>${count} nodes selected</h1>
          <p class="panel-subtitle">Drag any selected node to move the group.</p>
        </div>
      </div>
      ${panelRemoveAction(`Remove ${count} selected nodes`)}
    `;
    attachPanelRemoveAction();
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
    const usesAudioInputGain = node.wave === "audio-input";
    const audioInputGainValue = Number.isFinite(Number(node.audioInputGain)) ? node.audioInputGain : 1;

    panel.innerHTML = `
      <div class="panel-heading">
        <div>
          <h1 id="nodeHeading">${escapeHtml(nodeName(node))}</h1>
          <p class="panel-subtitle">Oscillator</p>
        </div>
      </div>
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
      ${usesAudioInputGain ? `
        <div class="field">
          ${parameterLabel("audioInputGain", "Input gain", "node", node.id, "audioInputGain")}
          <div class="field-row">
            <input id="audioInputGainRange" type="range" min="0" max="4" step="0.001" value="${audioInputGainValue}">
            <input id="audioInputGain" type="number" min="0" max="4" step="0.001" value="${audioInputGainValue}">
          </div>
        </div>
      ` : ""}
      ${panelRemoveAction(`Remove ${nodeName(node)}`)}
    `;

    attachPanelRemoveAction();
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
        node.audioInputGain = Number.isFinite(Number(node.audioInputGain)) ? node.audioInputGain : 1;
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
    if (usesAudioInputGain) {
      bindNumberPair("audioInputGain", "audioInputGainRange", 0, 4, (value) => {
        node.audioInputGain = value;
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
    const amountMax = link.modulationTarget === "mix" ? 1 : LINK_AMOUNT_SLIDER_MAX;
    const amountInputMax = link.modulationTarget === "mix" ? 1 : LINK_AMOUNT_INPUT_MAX;
    const usesEnvelopeControls = !link.drone;
    const signalMode = normalizeSignalMode(link.signalMode);
    const usesFollowerControls = signalMode !== "raw";
    const follower = link.follower || DEFAULT_LINK_FOLLOWER;
    const usesFilterControls = link.filter.type !== "none";
    const linkFilterTypes = LINK_FILTER_TYPES.filter((type) => type !== "none");
    const filterType = usesFilterControls ? link.filter.type : "lowpass";
    const filterControls = usesFilterControls ? `
      <div class="field">
        ${parameterLabel("filterType", "Type", "link", link.id, "filter.type")}
        <select id="filterType">
          ${linkFilterTypes.map((type) => `<option value="${type}" ${filterType === type ? "selected" : ""}>${filterTypeLabel(type)}</option>`).join("")}
        </select>
      </div>
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
    ` : "";
    if (modulationTargets.length && !modulationTargets.includes(link.modulationTarget)) {
      link.modulationTarget = modulationTargets[0];
      sendGraph();
      savePatch();
    }
    const envelopeControls = `
      <section class="effect-section">
        <div class="toggle-field">
          <label class="toggle-row" for="envelopeEnabled">
            <input id="envelopeEnabled" type="checkbox" ${usesEnvelopeControls ? "checked" : ""}>
            <span>Envelope</span>
          </label>
          <div class="section-heading-tools">
            ${usesEnvelopeControls ? envelopeMeter(link.id) : ""}
            ${midiCcButton("link", link.id, "drone")}
          </div>
        </div>
        ${usesEnvelopeControls ? `
        ${drawAdsr(link.envelope)}
        <div class="adsr-slider-grid">
          ${adsrField("delay", "D", "Delay", link.envelope.delay, 0, 4, link.id)}
          ${adsrField("attack", "A", "Attack", link.envelope.attack, 0.001, 4, link.id)}
          ${adsrField("decay", "D", "Decay", link.envelope.decay, 0.001, 4, link.id)}
          ${adsrField("sustain", "S", "Sustain", link.envelope.sustain, 0, 1, link.id)}
          ${adsrField("release", "R", "Release", link.envelope.release, 0.001, 6, link.id)}
        </div>
        ` : ""}
      </section>
    `;
    const followerControls = usesFollowerControls ? `
      <section class="effect-section">
        <div class="section-title">Follower</div>
        <div class="field">
          ${parameterLabel("followerAttack", "Attack", "link", link.id, "follower.attack")}
          <div class="field-row">
            <input id="followerAttackRange" type="range" min="0.001" max="2" step="0.001" value="${follower.attack}">
            <input id="followerAttack" type="number" min="0.001" max="2" step="0.001" value="${follower.attack}">
          </div>
        </div>
        <div class="field">
          ${parameterLabel("followerRelease", "Release", "link", link.id, "follower.release")}
          <div class="field-row">
            <input id="followerReleaseRange" type="range" min="0.001" max="4" step="0.001" value="${follower.release}">
            <input id="followerRelease" type="number" min="0.001" max="4" step="0.001" value="${follower.release}">
          </div>
        </div>
      </section>
    ` : "";

    panel.innerHTML = `
      <div class="panel-heading">
        <div>
          <h1>${link.to === "audio" ? "Output envelope" : targetKind === "link" ? "Link modulation" : "Modulation"}</h1>
          <p class="panel-subtitle">${from} -> ${to}</p>
        </div>
        ${linkMeter(link.id)}
      </div>
      ${modulationTargets.length ? `
        <div class="field">
          ${parameterLabel("modulationTarget", "Modulates", "link", link.id, "modulationTarget")}
          <select id="modulationTarget">
            ${modulationTargets.map((target) => `<option value="${target}" ${link.modulationTarget === target ? "selected" : ""}>${modulationTargetLabel(target, to)}</option>`).join("")}
          </select>
        </div>
      ` : ""}
      <div class="field">
        ${parameterLabel("signalMode", "Signal", "link", link.id, "signalMode")}
        <select id="signalMode">
          ${LINK_SIGNAL_MODES.map((mode) => `<option value="${mode}" ${signalMode === mode ? "selected" : ""}>${signalModeLabel(mode)}</option>`).join("")}
        </select>
      </div>
      ${followerControls}
      <div class="field">
        ${parameterLabel("amount", "Amplitude", "link", link.id, "amount")}
        <div class="field-row">
          <input id="amountRange" type="range" min="0" max="${amountMax}" step="0.001" value="${clamp(link.amount, 0, amountMax)}">
          <input id="amount" type="number" min="0" max="${amountInputMax}" step="0.001" value="${clamp(link.amount, 0, amountInputMax)}">
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
      ${envelopeControls}
      <section class="effect-section">
        <div class="toggle-field">
          <label class="toggle-row" for="filterEnabled">
            <input id="filterEnabled" type="checkbox" ${usesFilterControls ? "checked" : ""}>
            <span>Filter</span>
          </label>
          ${midiCcButton("link", link.id, "filter.enabled")}
        </div>
        ${filterControls}
      </section>
      ${panelRemoveAction("Remove selected link")}
    `;
    updateSelectedLinkMeter();
    attachPanelRemoveAction();

    bindNumberPair("amount", "amountRange", 0, amountMax, (value) => {
      link.amount = value;
      sendLinkParam(link.id, "amount", value);
      schedulePatchSave();
    }, { inputMax: amountInputMax });

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

    panel.querySelector("#envelopeEnabled").addEventListener("change", (event) => {
      link.drone = !event.target.checked;
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

    panel.querySelector("#signalMode").addEventListener("change", (event) => {
      link.signalMode = normalizeSignalMode(event.target.value);
      link.follower = link.follower || { ...DEFAULT_LINK_FOLLOWER };
      renderPanel();
      sendGraph();
      savePatch();
    });

    if (usesFollowerControls) {
      bindNumberPair("followerAttack", "followerAttackRange", 0.001, 2, (value) => {
        link.follower = { ...(link.follower || DEFAULT_LINK_FOLLOWER), attack: value };
        sendGraph();
        savePatch();
      });

      bindNumberPair("followerRelease", "followerReleaseRange", 0.001, 4, (value) => {
        link.follower = { ...(link.follower || DEFAULT_LINK_FOLLOWER), release: value };
        sendGraph();
        savePatch();
      });
    }

    panel.querySelector("#filterEnabled").addEventListener("change", (event) => {
      link.filter.type = event.target.checked ? (link.filter.type === "none" ? "lowpass" : link.filter.type) : "none";
      renderPanel();
      sendGraph();
      savePatch();
    });

    if (usesFilterControls) {
      panel.querySelector("#filterType").addEventListener("change", (event) => {
        link.filter.type = event.target.value;
        renderPanel();
        sendGraph();
        savePatch();
      });

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
      renderMasterEffectsPanel();
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

async function savePatchToServer() {
  const button = panel.querySelector("#savePatchButton");
  if (button) {
    button.disabled = true;
    button.textContent = "Saving";
  }

  try {
    const patch = currentPatchData();
    const response = await fetch("/api/patches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        patchName: patch.patchName,
        content: patchFileText(patch),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `Save failed (${response.status}).`);
    }
    if (button) button.textContent = "Saved";
    window.setTimeout(() => {
      const currentButton = panel.querySelector("#savePatchButton");
      if (currentButton) currentButton.textContent = "Save";
    }, 900);
  } catch (error) {
    alert(`Could not save patch: ${error.message}`);
    if (button) button.textContent = "Save";
  } finally {
    if (button) button.disabled = false;
  }
}

async function fetchSavedPatches() {
  const response = await fetch("/api/patches", { cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Could not list patches (${response.status}).`);
  }
  return Array.isArray(result.patches) ? result.patches : [];
}

async function loadSavedPatch(patchName, timestamp) {
  const response = await fetch(`/api/patches/${encodeURIComponent(patchName)}/${encodeURIComponent(timestamp)}`, {
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    let error = text.trim();
    try {
      error = JSON.parse(text).error || error;
    } catch {
      // Plain text errors are also useful enough to show.
    }
    throw new Error(error || `Could not load patch (${response.status}).`);
  }
  applyPatchData(parsePatchFile(text));
}

async function openPatchLibrary() {
  patchLibrary = {
    patches: [],
    selectedPatchName: null,
    selectedTimestamp: null,
    loading: true,
    error: "",
  };
  renderPatchLibraryModal();

  try {
    const patches = await fetchSavedPatches();
    patchLibrary.patches = patches;
    patchLibrary.selectedPatchName = patches[0]?.name || null;
    patchLibrary.selectedTimestamp = patches[0]?.timestamps?.[0] || null;
    patchLibrary.loading = false;
  } catch (error) {
    patchLibrary.loading = false;
    patchLibrary.error = error.message;
  }
  renderPatchLibraryModal();
}

function closePatchLibrary() {
  document.querySelector("#patchLibraryModal")?.remove();
  patchLibrary = null;
}

function renderPatchLibraryModal() {
  if (!patchLibrary) return;

  let backdrop = document.querySelector("#patchLibraryModal");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "patchLibraryModal";
    backdrop.className = "modal-backdrop";
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closePatchLibrary();
    });
    document.body.appendChild(backdrop);
  }

  const selectedPatch = patchLibrary.patches.find((patch) => patch.name === patchLibrary.selectedPatchName);
  const timestamps = selectedPatch?.timestamps || [];
  const canLoad = Boolean(patchLibrary.selectedPatchName && patchLibrary.selectedTimestamp);
  const patchRows = patchLibrary.patches.length
    ? patchLibrary.patches.map((patch) => `
      <button
        class="patch-library-row ${patch.name === patchLibrary.selectedPatchName ? "selected" : ""}"
        type="button"
        data-patch-name="${escapeHtml(patch.name)}"
      >
        <span>${escapeHtml(patch.name)}</span>
        <small>${patch.timestamps.length}</small>
      </button>
    `).join("")
    : `<p class="patch-library-empty">No server-saved patches yet.</p>`;
  const timestampRows = timestamps.length
    ? timestamps.map((timestamp) => `
      <button
        class="patch-library-row ${timestamp === patchLibrary.selectedTimestamp ? "selected" : ""}"
        type="button"
        data-timestamp="${escapeHtml(timestamp)}"
      >
        <span>${escapeHtml(formatSavedPatchTimestamp(timestamp))}</span>
      </button>
    `).join("")
    : `<p class="patch-library-empty">Choose a patch name.</p>`;

  backdrop.innerHTML = `
    <div class="modal patch-library-modal" role="dialog" aria-modal="true" aria-labelledby="patchLibraryTitle">
      <div class="patch-library-heading">
        <h2 id="patchLibraryTitle">Load Patch</h2>
        <button class="icon-button compact" id="closePatchLibraryButton" type="button" aria-label="Close" title="Close">x</button>
      </div>
      ${patchLibrary.error ? `<p class="modal-error">${escapeHtml(patchLibrary.error)}</p>` : ""}
      ${patchLibrary.loading ? `<p class="patch-library-empty">Loading saved patches...</p>` : `
        <div class="patch-library-grid">
          <section class="patch-library-column" aria-label="Patch names">
            <h3>Patch</h3>
            <div class="patch-library-list">${patchRows}</div>
          </section>
          <section class="patch-library-column" aria-label="Saved timestamps">
            <h3>Saved At</h3>
            <div class="patch-library-list">${timestampRows}</div>
          </section>
        </div>
      `}
      <div class="modal-actions">
        <button class="text-button" id="cancelPatchLibraryButton" type="button">Cancel</button>
        <button class="text-button primary" id="confirmLoadPatchButton" type="button" ${canLoad ? "" : "disabled"}>Load</button>
      </div>
    </div>
  `;

  backdrop.querySelector("#closePatchLibraryButton").addEventListener("click", closePatchLibrary);
  backdrop.querySelector("#cancelPatchLibraryButton").addEventListener("click", closePatchLibrary);
  backdrop.querySelectorAll("[data-patch-name]").forEach((button) => {
    button.addEventListener("click", () => {
      const patchName = button.dataset.patchName;
      const patch = patchLibrary.patches.find((item) => item.name === patchName);
      patchLibrary.selectedPatchName = patchName;
      patchLibrary.selectedTimestamp = patch?.timestamps?.[0] || null;
      renderPatchLibraryModal();
    });
  });
  backdrop.querySelectorAll("[data-timestamp]").forEach((button) => {
    button.addEventListener("click", () => {
      patchLibrary.selectedTimestamp = button.dataset.timestamp;
      renderPatchLibraryModal();
    });
  });
  backdrop.querySelector("#confirmLoadPatchButton").addEventListener("click", async (event) => {
    if (!patchLibrary.selectedPatchName || !patchLibrary.selectedTimestamp) return;
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = "Loading";
    try {
      await loadSavedPatch(patchLibrary.selectedPatchName, patchLibrary.selectedTimestamp);
      closePatchLibrary();
    } catch (error) {
      patchLibrary.error = error.message;
      renderPatchLibraryModal();
    }
  });
}

function formatSavedPatchTimestamp(timestamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(-\d+)?$/.exec(timestamp);
  if (!match) return timestamp;
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}${match[7] || ""}`;
}

function applyPatchData(patch) {
  const normalized = normalizePatch(patch);
  state.patchName = normalized.patchName;
  state.maxVoices = normalized.maxVoices;
  state.audioInputDeviceId = normalized.audioInputDeviceId;
  state.audioOutputDeviceId = normalized.audioOutputDeviceId;
  state.linkSignalGradientMeters = normalized.linkSignalGradientMeters;
  state.midiChannel = normalized.midiChannel;
  state.midiInputId = normalized.midiInputId;
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
  syncAudioOutputDevice()
    .then(() => reconcileAudioInput())
    .then(() => updateAudioStatus())
    .catch(() => updateAudioStatus({ inputBlocked: true }));
  savePatch();
}

function newPatch() {
  if (!confirm("Clear the current patch and start a new one? Unsaved changes will be lost.")) {
    return;
  }

  const midiChannel = state.midiChannel;
  const midiInputId = state.midiInputId;
  const audioInputDeviceId = state.audioInputDeviceId;
  const audioOutputDeviceId = state.audioOutputDeviceId;
  const linkSignalGradientMeters = state.linkSignalGradientMeters;
  const normalized = normalizeDefaultPatch();
  state.patchName = "Untitled Patch";
  state.maxVoices = normalized.maxVoices;
  state.audioInputDeviceId = audioInputDeviceId;
  state.audioOutputDeviceId = audioOutputDeviceId;
  state.linkSignalGradientMeters = linkSignalGradientMeters;
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
      ${effect.enabled ? params.map(([key, label, min, max, unit]) => effectField(id, key, label, effect[key], min, max, unit)).join("") : ""}
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

function signalModeLabel(mode) {
  const labels = {
    raw: "Raw",
    envelope: "Envelope",
    "inverted-envelope": "Inverted Envelope",
  };
  return labels[mode] || mode;
}

function linkMeter(linkId) {
  const levels = linkMeterLevels.get(linkId) || { input: 0, output: 0, envelope: 0 };
  return `
    <div class="link-meter" data-link-meter="${escapeHtml(linkId)}" aria-label="Link signal meter">
      <div class="link-meter-channel">
        <span class="link-meter-label">in</span>
        <span class="link-meter-track" aria-hidden="true">
          <span class="link-meter-fill" data-link-meter-fill="input" style="transform: scaleY(${clamp(levels.input || 0, 0, 1)})"></span>
        </span>
      </div>
      <div class="link-meter-channel">
        <span class="link-meter-label">out</span>
        <span class="link-meter-track" aria-hidden="true">
          <span class="link-meter-fill" data-link-meter-fill="output" style="transform: scaleY(${clamp(levels.output || 0, 0, 1)})"></span>
        </span>
      </div>
    </div>
  `;
}

function envelopeMeter(linkId) {
  const levels = linkMeterLevels.get(linkId) || { input: 0, output: 0, envelope: 0 };
  return `
    <div class="link-meter envelope-meter" data-envelope-meter="${escapeHtml(linkId)}" aria-label="Envelope level meter">
      <div class="link-meter-channel">
        <span class="link-meter-track" aria-hidden="true">
          <span class="link-meter-fill" data-link-meter-fill="envelope" style="transform: scaleY(${clamp(levels.envelope || 0, 0, 1)})"></span>
        </span>
      </div>
    </div>
  `;
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
        <label for="${name}" title="${escapeHtml(label)}">${escapeHtml(letter)}</label>
        ${midiCcButton("link", linkId, `envelope.${name}`)}
      </div>
      <input class="adsr-slider" id="${name}Range" type="range" min="${min}" max="${max}" step="0.001" value="${value}" aria-label="${escapeHtml(label)}">
      <input class="adsr-value" id="${name}" type="number" min="${min}" max="${max}" step="0.001" value="${value}" aria-label="${escapeHtml(label)} value">
    </div>
  `;
}

function bindNumberPair(numberId, rangeId, min, max, onValue, options = {}) {
  const number = panel.querySelector(`#${numberId}`);
  const range = panel.querySelector(`#${rangeId}`);
  const step = valueSliderStep(number, range);
  const inputMax = Number.isFinite(options.inputMax) ? options.inputMax : max;

  const commitValue = (rawValue, { updateNumber = true, valueMax = max } = {}) => {
    if (rawValue === "" || rawValue === "." || rawValue === "-") return;

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return;

    const value = snapValueSliderValue(parsed, min, valueMax, step);
    if (updateNumber) {
      syncValueSliderNumber(number, range, value);
    }
    range.value = String(value);
    syncValueSliderProgress(range, min, max);
    onValue(value);
  };

  enhanceValueSlider(number, range, min, max, step);
  number.addEventListener("input", (event) => commitValue(event.target.value, { updateNumber: false, valueMax: inputMax }));
  number.addEventListener("focus", (event) => event.target.select());
  number.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      commitValue(event.currentTarget.value, { valueMax: inputMax });
      event.currentTarget.blur();
    }
  });
  number.addEventListener("blur", (event) => commitValue(event.target.value, { valueMax: inputMax }));
  range.addEventListener("input", (event) => commitValue(event.target.value));
  bindPrecisionRangeDrag(range, min, max, commitValue);
}

function enhanceValueSlider(number, range, min, max, step) {
  if (!number || !range || range.dataset.valueSliderEnhanced) return;

  const control = document.createElement("div");
  const vertical = range.classList.contains("adsr-slider");
  control.className = `value-slider ${vertical ? "value-slider--vertical" : "value-slider--horizontal"}`;
  control.dataset.valueSlider = "";

  const parent = range.parentElement;
  if (parent?.classList.contains("field-row")) {
    parent.classList.add("value-slider-row");
  }

  range.before(control);
  control.append(range, number);

  range.dataset.valueSliderEnhanced = "true";
  range.classList.add("value-slider-range");
  range.tabIndex = -1;
  range.setAttribute("aria-hidden", "true");

  number.classList.add("value-slider-input");
  number.readOnly = true;
  number.setAttribute("inputmode", "decimal");

  number.addEventListener("focus", () => {
    control.classList.add("is-editing");
    number.readOnly = false;
    number.value = formatEditableValue(Number(number.value), step);
  });
  number.addEventListener("blur", () => {
    control.classList.remove("is-editing");
    number.readOnly = true;
    syncValueSliderNumber(number, range, Number(number.value));
  });

  syncValueSliderProgress(range, min, max);
  syncValueSliderNumber(number, range, Number(number.value));
}

function syncValueSliderProgress(range, min, max) {
  const control = range?.closest(".value-slider");
  const rangeSpan = max - min;
  if (!control || !Number.isFinite(rangeSpan) || rangeSpan <= 0) return;

  const value = clamp(Number(range.value), min, max);
  const ratio = clamp((value - min) / rangeSpan, 0, 1);
  control.style.setProperty("--value-percent", `${ratio * 100}%`);
}

function syncValueSliderNumber(number, range, value) {
  if (!number) return;

  const step = valueSliderStep(number, range);
  const editing = !number.readOnly;
  number.value = editing
    ? formatEditableValue(value, step)
    : formatDisplayValue(value, step);
}

function valueSliderStep(number, range) {
  const step = Number(number?.step || range?.step);
  return Number.isFinite(step) && step > 0 ? step : 0;
}

function snapValueSliderValue(value, min, max, step) {
  if (!Number.isFinite(step) || step <= 0) return clamp(value, min, max);

  const decimals = decimalPlaces(step);
  const snapped = min + Math.round((value - min) / step) * step;
  return clamp(Number(snapped.toFixed(Math.min(decimals + 2, 10))), min, max);
}

function decimalPlaces(value) {
  const text = String(value);
  if (text.includes("e-")) return Number(text.split("e-")[1]) || 0;
  const [, decimals = ""] = text.split(".");
  return decimals.length;
}

function formatEditableValue(value, step) {
  if (!Number.isFinite(value)) return "";

  const decimals = Math.min(decimalPlaces(step), 6);
  return trimNumberString(decimals > 0 ? value.toFixed(decimals) : String(Math.round(value)));
}

function formatDisplayValue(value, step) {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "0";

  const abs = Math.abs(value);
  const stepDecimals = Number.isFinite(step) && step > 0 ? decimalPlaces(step) : 3;
  const magnitudeDecimals = abs >= 100
    ? 0
    : abs >= 10
      ? 1
      : abs >= 1
        ? 2
        : abs >= 0.01
          ? 3
          : 4;
  const decimals = Math.min(Math.max(0, stepDecimals), magnitudeDecimals);
  return trimNumberString(value.toFixed(decimals));
}

function trimNumberString(value) {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function focusValueSliderNumber(number) {
  number.readOnly = false;
  number.focus({ preventScroll: true });
  number.select();
}

function bindPrecisionRangeDrag(range, min, max, commitValue) {
  const rangeSpan = max - min;
  if (!range || rangeSpan <= 0) return;

  let drag = null;
  const control = range.closest(".value-slider") || range;
  const number = control.querySelector?.(".value-slider-input");
  const fineScale = (event) => (event.altKey || isFineSliderActive() ? FINE_SLIDER_SCALE : 1);

  control.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (control.classList?.contains("is-editing")) return;
    event.preventDefault();

    const rect = control.getBoundingClientRect();
    const vertical = rect.height > rect.width;
    const currentValue = clamp(Number(range.value), min, max);
    const pointerAxis = vertical ? event.clientY : event.clientX;
    drag = {
      pointerId: event.pointerId,
      rect,
      vertical,
      currentValue,
      started: false,
      startX: event.clientX,
      startY: event.clientY,
      lastAxis: pointerAxis,
    };

    control.setPointerCapture?.(event.pointerId);
  });

  control.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();

    const axisSize = drag.vertical ? drag.rect.height : drag.rect.width;
    if (axisSize <= 0) return;

    const totalDelta = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.started && totalDelta < VALUE_SLIDER_DRAG_THRESHOLD_PX) return;
    drag.started = true;
    control.classList?.add("is-dragging");

    const axis = drag.vertical ? event.clientY : event.clientX;
    const perpendicular = drag.vertical
      ? Math.abs(event.clientX - drag.startX)
      : Math.abs(event.clientY - drag.startY);
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
    control.releasePointerCapture?.(event.pointerId);
    if (event.type === "pointerup" && !drag.started && number) {
      focusValueSliderNumber(number);
    }
    control.classList?.remove("is-dragging");
    drag = null;
  };

  control.addEventListener("pointerup", endDrag);
  control.addEventListener("pointercancel", endDrag);
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
  const audioInputOptions = audioDeviceOptions(
    audioInputDevices(),
    selectedAudioDeviceId("input"),
    "System default input",
    "Audio input",
    "Unavailable input",
  );
  const audioOutputOptions = audioDeviceOptions(
    audioOutputDevices(),
    selectedAudioDeviceId("output"),
    "System default output",
    "Audio output",
    "Unavailable output",
  );
  const audioBackendOptions = Object.entries(AUDIO_BACKENDS).map(([id, backend]) => (
    `<option value="${id}" ${audioBackend === id ? "selected" : ""}>${escapeHtml(backend.label)}</option>`
  )).join("");

  panel.innerHTML = `
    <div class="panel-empty">
      <h1>Patch</h1>
      <p class="panel-subtitle">File, audio, and MIDI settings</p>
      <div class="field">
        <label for="patchName">Name</label>
        <input id="patchName" type="text" value="${escapeHtml(state.patchName)}" autocomplete="off">
      </div>
      <div class="panel-actions">
        <button class="text-button" id="newPatchButton" type="button">New</button>
        <button class="text-button" id="savePatchButton" type="button">Save</button>
        <button class="text-button" id="loadPatchButton" type="button">Load</button>
      </div>
      <div class="field">
        <label for="maxVoices">Max voices</label>
        <div class="field-row">
          <input id="maxVoicesRange" type="range" min="${MIN_MAX_VOICES}" max="${MAX_MAX_VOICES}" step="1" value="${state.maxVoices}">
          <input id="maxVoices" type="number" min="${MIN_MAX_VOICES}" max="${MAX_MAX_VOICES}" step="1" value="${state.maxVoices}">
        </div>
      </div>
      <div class="field">
        <label for="audioEngine">Audio engine</label>
        <select id="audioEngine">${audioBackendOptions}</select>
      </div>
      <label class="toggle-row">
        <input id="linkSignalGradientMeters" type="checkbox" ${state.linkSignalGradientMeters ? "checked" : ""}>
        <span>Visualise signal flow</span>
      </label>
      <div class="field">
        <label for="audioInputDevice">Audio input</label>
        <select id="audioInputDevice">${audioInputOptions}</select>
      </div>
      <div class="field">
        <label for="audioOutputDevice">Audio output</label>
        <select id="audioOutputDevice">${audioOutputOptions}</select>
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
    renderAppTitle();
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
  panel.querySelector("#audioEngine").addEventListener("change", (event) => {
    audioBackend = normalizeAudioBackend(event.target.value);
    try {
      localStorage.setItem(AUDIO_BACKEND_STORAGE_KEY, audioBackend);
    } catch {
      // The URL flag still carries the backend choice when storage is unavailable.
    }
    const url = new URL(window.location.href);
    if (audioBackend === "js") {
      url.searchParams.delete("engine");
    } else {
      url.searchParams.set("engine", audioBackend);
    }
    window.location.href = url.toString();
  });
  panel.querySelector("#linkSignalGradientMeters").addEventListener("change", (event) => {
    state.linkSignalGradientMeters = event.target.checked;
    renderWires();
    if (state.linkSignalGradientMeters) updateWireSignalMeters();
    savePatch();
  });
  panel.querySelector("#audioInputDevice").addEventListener("change", (event) => {
    state.audioInputDeviceId = event.target.value;
    if (patchUsesAudioInput()) {
      stopAudioInput();
      reconcileAudioInput();
    }
    savePatch();
  });
  panel.querySelector("#audioOutputDevice").addEventListener("change", async (event) => {
    const previousDeviceId = state.audioOutputDeviceId;
    state.audioOutputDeviceId = event.target.value;
    try {
      await ensureAudio();
      const outputReady = await syncAudioOutputDevice();
      if (outputReady) {
        await refreshAudioDevices();
      } else {
        state.audioOutputDeviceId = previousDeviceId;
        await syncAudioOutputDevice();
      }
    } catch {
      state.audioOutputDeviceId = previousDeviceId;
      await syncAudioOutputDevice();
      audioOutputRouteError = "Audio output blocked";
    }
    updateAudioStatus();
    renderPanel();
    savePatch();
  });
  panel.querySelector("#savePatchButton").addEventListener("click", savePatchToServer);
  panel.querySelector("#newPatchButton").addEventListener("click", newPatch);
  panel.querySelector("#loadPatchButton").addEventListener("click", openPatchLibrary);
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
  renderAppTitle();
  renderNodes();
  renderWires();
  renderAudioOut();
  renderPanel();
}

function renderAppTitle() {
  const patchName = state.patchName?.trim() || "Untitled Patch";
  appTitle.textContent = `Visual FM - ${patchName}`;
  document.title = `Visual FM - ${patchName}`;
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
    audioInputGain: 1,
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

function removeSelectedElements() {
  if (state.selected.type === "node" && state.selected.id) {
    removeNode(state.selected.id);
    return true;
  }

  if (state.selected.type === "nodes") {
    const ids = selectedNodeIds();
    if (!ids.length) return false;
    removeNodes(ids);
    return true;
  }

  if (state.selected.type === "link" && state.selected.id) {
    removeLink(state.selected.id);
    return true;
  }

  return false;
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
    signalMode: "raw",
    follower: { ...DEFAULT_LINK_FOLLOWER },
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
  if (event.button !== 0 || !isPrimaryDragPointer(event)) return;

  const anchor = event.target.closest("[data-anchor]");
  const nodeElement = event.currentTarget;
  const nodeId = nodeElement.dataset.nodeId;

  event.preventDefault();
  ensureAudio();

  if (anchor?.dataset.anchor === "output") {
    event.stopPropagation();
    const stageRect = stage.getBoundingClientRect();
    linkDrag = {
      pointerId: event.pointerId,
      from: nodeId,
      stageRect,
      to: stagePointFromRect(event.clientX, event.clientY, stageRect),
    };
    captureStagePointer(event.pointerId);
    window.addEventListener("pointermove", onLinkPointerMove);
    window.addEventListener("pointerup", onLinkPointerEnd);
    window.addEventListener("pointercancel", onLinkPointerEnd);
    stage.addEventListener("lostpointercapture", onLinkPointerEnd);
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

  const stageRect = stage.getBoundingClientRect();
  const start = stagePointFromRect(event.clientX, event.clientY, stageRect);
  const sourceIds = isNodeSelected(nodeId) ? selectedNodeIds() : [nodeId];
  const ids = event.altKey ? duplicateNodes(sourceIds).copies.map((node) => node.id) : sourceIds;
  dragState = {
    pointerId: event.pointerId,
    stageRect,
    nodes: ids.map((id) => {
      const node = nodeById(id);
      return {
        id,
        offsetX: start.x - node.x,
        offsetY: start.y - node.y,
      };
    }),
  };
  captureStagePointer(event.pointerId);
  window.addEventListener("pointermove", onNodePointerMove);
  window.addEventListener("pointerup", onNodePointerEnd);
  window.addEventListener("pointercancel", onNodePointerEnd);
  stage.addEventListener("lostpointercapture", onNodePointerEnd);
  if (!event.altKey && !isNodeSelected(nodeId)) {
    select("node", nodeId);
  }
}

function onNodePointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const rect = dragState.stageRect || stage.getBoundingClientRect();
  const point = stagePointFromRect(event.clientX, event.clientY, rect);
  const movedIds = [];
  for (const item of dragState.nodes) {
    const node = nodeById(item.id);
    if (!node) continue;
    node.x = clamp(point.x - item.offsetX, 90, rect.width - 90);
    node.y = clamp(point.y - item.offsetY, 96, rect.height - 126);
    movedIds.push(item.id);
  }
  scheduleNodesAndWiresRender(movedIds);
}

function onNodePointerEnd(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const pointerId = dragState.pointerId;
  if (dragState) {
    savePatch();
  }
  dragState = null;
  window.removeEventListener("pointermove", onNodePointerMove);
  window.removeEventListener("pointerup", onNodePointerEnd);
  window.removeEventListener("pointercancel", onNodePointerEnd);
  stage.removeEventListener("lostpointercapture", onNodePointerEnd);
  releaseStagePointer(pointerId);
}

function onLinkPointerMove(event) {
  if (!linkDrag || event.pointerId !== linkDrag.pointerId) return;
  linkDrag.to = stagePointFromRect(
    event.clientX,
    event.clientY,
    linkDrag.stageRect || stage.getBoundingClientRect(),
  );
  scheduleWiresRender();
}

function onLinkPointerEnd(event) {
  if (!linkDrag || event.pointerId !== linkDrag.pointerId) return;
  const pointerId = linkDrag.pointerId;

  if (event.type === "pointerup") {
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
  }

  linkDrag = null;
  window.removeEventListener("pointermove", onLinkPointerMove);
  window.removeEventListener("pointerup", onLinkPointerEnd);
  window.removeEventListener("pointercancel", onLinkPointerEnd);
  stage.removeEventListener("lostpointercapture", onLinkPointerEnd);
  releaseStagePointer(pointerId);
  renderWires();
}

function onStageResize() {
  if (dragState) dragState.stageRect = stage.getBoundingClientRect();
  if (linkDrag) linkDrag.stageRect = stage.getBoundingClientRect();
  if (marqueeState) marqueeState.stageRect = stage.getBoundingClientRect();
  scheduleWiresRender();
}

function isEmptyCanvasTarget(target) {
  return target === stage || target === nodeLayer || target === wireLayer;
}

function isEditingValueSliderInput(element = document.activeElement) {
  return element?.classList?.contains("value-slider-input") && !element.readOnly;
}

function trackValueEditExitClick(event) {
  preserveSelectionAfterValueEditClick = Boolean(
    isEditingValueSliderInput()
      && !event.target.closest?.(".value-slider")
      && (state.selected.type === "node" || state.selected.type === "link"),
  );
}

function onStagePointerDown(event) {
  if (event.button !== 0 || !isEmptyCanvasTarget(event.target)) return;
  if (!isPrimaryDragPointer(event)) return;
  if (preserveSelectionAfterValueEditClick) return;

  const stageRect = stage.getBoundingClientRect();
  const point = stagePointFromRect(event.clientX, event.clientY, stageRect);
  marqueeState = {
    pointerId: event.pointerId,
    active: true,
    moved: false,
    stageRect,
    start: point,
    current: point,
  };
  captureStagePointer(event.pointerId);
  renderSelectionRect();
  window.addEventListener("pointermove", onMarqueePointerMove);
  window.addEventListener("pointerup", onMarqueePointerEnd);
  window.addEventListener("pointercancel", onMarqueePointerEnd);
  stage.addEventListener("lostpointercapture", onMarqueePointerEnd);
}

function onMarqueePointerMove(event) {
  if (!marqueeState || event.pointerId !== marqueeState.pointerId) return;

  marqueeState.current = stagePointFromRect(
    event.clientX,
    event.clientY,
    marqueeState.stageRect || stage.getBoundingClientRect(),
  );
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

function onMarqueePointerEnd(event) {
  if (!marqueeState || event.pointerId !== marqueeState.pointerId) return;

  const pointerId = marqueeState.pointerId;
  const shouldSelect = event.type === "pointerup" && marqueeState.moved;
  const ids = shouldSelect ? nodesInsideSelection() : [];
  marqueeState = null;
  renderSelectionRect();
  window.removeEventListener("pointermove", onMarqueePointerMove);
  window.removeEventListener("pointerup", onMarqueePointerEnd);
  window.removeEventListener("pointercancel", onMarqueePointerEnd);
  stage.removeEventListener("lostpointercapture", onMarqueePointerEnd);
  releaseStagePointer(pointerId);

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

document.addEventListener("pointerdown", trackValueEditExitClick, true);
document.addEventListener("click", () => {
  preserveSelectionAfterValueEditClick = false;
});

wireLayer.addEventListener("click", (event) => {
  const linkTarget = event.target.closest?.("[data-link-id]");
  if (!linkTarget || !wireLayer.contains(linkTarget)) return;
  event.stopPropagation();
  select("link", linkTarget.dataset.linkId);
});

stage.addEventListener("pointerdown", onStagePointerDown);

stage.addEventListener("dblclick", (event) => {
  if (!isEmptyCanvasTarget(event.target)) return;
  ensureAudio();
  addNode(stagePoint(event.clientX, event.clientY));
});

stage.addEventListener("click", (event) => {
  if (preserveSelectionAfterValueEditClick && isEmptyCanvasTarget(event.target)) {
    preserveSelectionAfterValueEditClick = false;
    return;
  }
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
  if (event.key === "Backspace" || event.key === "Delete") {
    const removed = removeSelectedElements();
    if (!removed) return;
    event.preventDefault();
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

navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  refreshAudioDevices({ renderPatchPanel: !state.selected.type });
});

render();
refreshAudioDevices({ renderPatchPanel: !state.selected.type });
setupMidi();
requestAnimationFrame(showAudioEnableModal);
