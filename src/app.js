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

const STORAGE_KEY = "visual-fm.patch.v1";
const LINK_FILTER_TYPES = ["none", "lowpass", "highpass", "bandpass"];
const WAVE_TYPES = ["sine", "triangle", "saw", "square", "noise"];
const FREQUENCY_MODES = ["ratio", "fixed"];
const NODE_MODULATION_TARGETS = ["phase", "frequency", "ring", "fold", "mix"];
const LINK_MODULATION_TARGETS = ["filterCutoff", "filterResonance", "amplitude", "delay", "pan"];
const DEFAULT_LINK_FILTER = { type: "none", cutoff: 5000, resonance: 0.7 };
const VELOCITY_SENSITIVITY_MAX = 8;
const DEFAULT_MAX_VOICES = 5;
const MIN_MAX_VOICES = 1;
const MAX_MAX_VOICES = 16;
const NODE_MIDI_PARAMETERS = new Set(["wave", "frequencyMode", "ratio", "frequency"]);
const LINK_MIDI_PARAMETERS = new Set([
  "modulationTarget",
  "amount",
  "pan",
  "velocitySensitivity",
  "delay",
  "drone",
  "filter.type",
  "filter.cutoff",
  "filter.resonance",
  "envelope.delay",
  "envelope.attack",
  "envelope.decay",
  "envelope.sustain",
  "envelope.release",
]);

const defaultPatch = {
  patchName: "Visual FM Patch",
  maxVoices: DEFAULT_MAX_VOICES,
  midiChannel: "all",
  midiInputId: "all",
  midiBindings: [],
  masterEffects: {
    chorus: { enabled: false, rate: 0.8, depth: 0.012, mix: 0.25 },
    delay: { enabled: false, time: 0.28, feedback: 0.35, mix: 0.25 },
    reverb: { enabled: false, size: 0.55, decay: 0.45, mix: 0.25 },
  },
  nodes: [
    { id: "op-1", name: "A", x: 260, y: 220, wave: "sine", frequencyMode: "ratio", ratio: 1, frequency: 440 },
    { id: "op-2", name: "B", x: 490, y: 180, wave: "sine", frequencyMode: "ratio", ratio: 2, frequency: 880 },
  ],
  links: [
    {
      id: "link-1",
      from: "op-2",
      to: "op-1",
      amount: 0.8,
      delay: 0,
      velocitySensitivity: 0,
      modulationTarget: "phase",
      drone: false,
      filter: { ...DEFAULT_LINK_FILTER },
      envelope: { delay: 0, attack: 0.03, decay: 0.16, sustain: 0.65, release: 0.26 },
    },
    {
      id: "link-2",
      from: "op-1",
      to: "audio",
      amount: 0.9,
      delay: 0,
      pan: 0,
      velocitySensitivity: 1,
      modulationTarget: "amplitude",
      drone: false,
      filter: { ...DEFAULT_LINK_FILTER },
      envelope: { delay: 0, attack: 0.01, decay: 0.18, sustain: 0.78, release: 0.32 },
    },
  ],
};

const state = {
  ...loadPatch(),
  selected: { type: "node", id: "op-1" },
};

const keyMap = new Map([
  ["z", 48],
  ["s", 49],
  ["x", 50],
  ["d", 51],
  ["c", 52],
  ["v", 53],
  ["g", 54],
  ["b", 55],
  ["h", 56],
  ["n", 57],
  ["j", 58],
  ["m", 59],
  [",", 60],
]);

let audioContext = null;
let synthNode = null;
let recorderDestination = null;
let mediaRecorder = null;
let recordingChunks = [];
let recordingStartedAt = null;
let nodeCounter = 3;
let linkCounter = 3;
let midiBindingCounter = 1;
let dragState = null;
let linkDrag = null;
let marqueeState = null;
let pressedKeys = new Set();
let midiAccess = null;
let pendingPatchSave = null;
let suppressNextStageClick = false;

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

function alphaName(index) {
  let name = "";
  let value = index + 1;

  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }

  return name;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function clonePatch(patch) {
  return JSON.parse(JSON.stringify(patch));
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

function normalizeLinkFilter(filter = {}) {
  const type = LINK_FILTER_TYPES.includes(filter.type) ? filter.type : DEFAULT_LINK_FILTER.type;
  return {
    type,
    cutoff: Number.isFinite(Number(filter.cutoff))
      ? clamp(Number(filter.cutoff), 20, 12000)
      : DEFAULT_LINK_FILTER.cutoff,
    resonance: Number.isFinite(Number(filter.resonance))
      ? clamp(Number(filter.resonance), 0.1, 12)
      : DEFAULT_LINK_FILTER.resonance,
  };
}

function linkHasPan(link) {
  return link?.to === "audio";
}

function normalizeModulationTarget(target, to, targetLink = null) {
  if (to === "audio") return "amplitude";
  if (targetLink) {
    const targets = linkHasPan(targetLink)
      ? LINK_MODULATION_TARGETS
      : LINK_MODULATION_TARGETS.filter((item) => item !== "pan");
    return targets.includes(target) ? target : "filterCutoff";
  }
  return NODE_MODULATION_TARGETS.includes(target) ? target : "phase";
}

function normalizeFrequencyMode(mode) {
  return FREQUENCY_MODES.includes(mode) ? mode : "ratio";
}

function normalizeMidiBindings(bindings, nodes, links) {
  if (!Array.isArray(bindings)) return [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const linkIds = new Set(links.map((link) => link.id));
  return bindings
    .map((binding, index) => {
      const targetType = binding.targetType === "link" ? "link" : "node";
      const targetId = typeof binding.targetId === "string" ? binding.targetId : "";
      const parameter = typeof binding.parameter === "string" ? binding.parameter : "";
      const cc = Number(binding.cc);

      return {
        id: typeof binding.id === "string" && binding.id.trim()
          ? binding.id
          : `midi-binding-${index + 1}`,
        targetType,
        targetId,
        parameter,
        cc: Number.isFinite(cc) ? clamp(Math.round(cc), 0, 127) : 0,
      };
    })
    .filter((binding) => (
      (binding.targetType === "node" ? nodeIds.has(binding.targetId) : linkIds.has(binding.targetId))
        && (binding.targetType === "link" ? LINK_MIDI_PARAMETERS : NODE_MIDI_PARAMETERS).has(binding.parameter)
    ));
}

function normalizePatch(patch) {
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
  const nodes = source.nodes.map((node, index) => ({
    id: typeof node.id === "string" ? node.id : `op-${index + 1}`,
    name: typeof node.name === "string" && node.name.trim() ? node.name : alphaName(index),
    x: Number.isFinite(node.x) ? node.x : 220 + index * 210,
    y: Number.isFinite(node.y) ? node.y : 220,
    wave: WAVE_TYPES.includes(node.wave) ? node.wave : "sine",
    frequencyMode: normalizeFrequencyMode(node.frequencyMode),
    ratio: Number.isFinite(Number(node.ratio)) ? clamp(Number(node.ratio), 0, 16) : 1,
    frequency: Number.isFinite(Number(node.frequency)) ? clamp(Number(node.frequency), 0, 12000) : 440,
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const sourceLinkIds = new Set(source.links.map((link, index) => (
    typeof link.id === "string" ? link.id : `link-${index + 1}`
  )));
  const sourceLinksById = new Map(source.links.map((link, index) => [
    typeof link.id === "string" ? link.id : `link-${index + 1}`,
    link,
  ]));
  let links = source.links
    .filter((link, index) => {
      const id = typeof link.id === "string" ? link.id : `link-${index + 1}`;
      return nodeIds.has(link.from)
        && (nodeIds.has(link.to) || link.to === "audio" || (sourceLinkIds.has(link.to) && link.to !== id));
    })
    .map((link, index) => ({
      id: typeof link.id === "string" ? link.id : `link-${index + 1}`,
      from: link.from,
      to: link.to,
      amount: Number.isFinite(Number(link.amount)) ? Number(link.amount) : 0.65,
      delay: Number.isFinite(Number(link.delay)) ? clamp(Number(link.delay), 0, 3) : 0,
      pan: Number.isFinite(Number(link.pan)) ? clamp(Number(link.pan), -1, 1) : 0,
      velocitySensitivity: Number.isFinite(Number(link.velocitySensitivity))
        ? clamp(Number(link.velocitySensitivity), 0, VELOCITY_SENSITIVITY_MAX)
        : link.to === "audio" ? 1 : 0,
      modulationTarget: normalizeModulationTarget(
        link.modulationTarget,
        link.to,
        sourceLinkIds.has(link.to) ? sourceLinksById.get(link.to) : null,
      ),
      drone: Boolean(link.drone),
      filter: normalizeLinkFilter(link.filter),
      envelope: {
        delay: Number.isFinite(Number(link.envelope?.delay)) ? Number(link.envelope.delay) : 0,
        attack: Number.isFinite(Number(link.envelope?.attack)) ? Number(link.envelope.attack) : 0.03,
        decay: Number.isFinite(Number(link.envelope?.decay)) ? Number(link.envelope.decay) : 0.16,
        sustain: Number.isFinite(Number(link.envelope?.sustain)) ? Number(link.envelope.sustain) : 0.65,
        release: Number.isFinite(Number(link.envelope?.release)) ? Number(link.envelope.release) : 0.26,
      },
    }));
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
    midiChannel,
    midiInputId,
    midiBindings: normalizeMidiBindings(source.midiBindings, nodes, links),
    masterEffects: normalizeMasterEffects(source.masterEffects),
    nodes,
    links,
  };
}

function loadPatch() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return normalizePatch(saved ? JSON.parse(saved) : clonePatch(defaultPatch));
  } catch {
    return normalizePatch(clonePatch(defaultPatch));
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nodeById(id) {
  return state.nodes.find((node) => node.id === id);
}

function linkById(id) {
  return state.links.find((link) => link.id === id);
}

function nodeParameterDefinitions(node) {
  return [
    {
      id: "wave",
      label: "Wave type",
      type: "choice",
      options: WAVE_TYPES.map((value) => ({ value, label: value })),
      get: () => node.wave,
      set: (value) => {
        node.wave = value;
      },
    },
    {
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
    },
  ];
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
      label: "Velocity",
      type: "number",
      min: 0,
      max: VELOCITY_SENSITIVITY_MAX,
      get: () => link.velocitySensitivity,
      set: (value) => {
        link.velocitySensitivity = value;
      },
    },
    {
      id: "delay",
      label: "Delay",
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

function midiParameterDefinitions(targetType, targetId) {
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
  if (targetType === "link") {
    return linkName(linkById(targetId));
  }

  return nodeName(nodeById(targetId));
}

function midiParameterLabel(binding) {
  return midiParameterDefinition(binding)?.label || binding.parameter;
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

function valueFromCc(definition, value) {
  const normal = clamp(Number(value) || 0, 0, 127) / 127;
  if (definition.type === "choice") {
    const index = clamp(Math.round(normal * (definition.options.length - 1)), 0, definition.options.length - 1);
    return definition.options[index].value;
  }
  if (definition.type === "boolean") {
    return normal >= 0.5;
  }
  return definition.min + normal * (definition.max - definition.min);
}

function applyMidiCc(cc, value) {
  let changed = false;
  let shouldRenderNodes = false;
  let shouldRenderPanel = false;

  for (const binding of state.midiBindings) {
    if (binding.cc !== cc) continue;

    const definition = midiParameterDefinition(binding);
    if (!definition) continue;

    definition.set(valueFromCc(definition, value));
    changed = true;
    shouldRenderNodes = shouldRenderNodes || binding.targetType === "node";
    shouldRenderPanel = shouldRenderPanel
      || (state.selected.type === binding.targetType && state.selected.id === binding.targetId);
  }

  if (!changed) return;

  if (shouldRenderNodes) renderNodes();
  if (shouldRenderPanel) renderPanel();
  sendGraph();
  schedulePatchSave();
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
  return bezierPoint(nodeOutputPoint(link.from), to, 0.5);
}

function linkGeometry(link, visited = new Set()) {
  if (!link || !nodeById(link.from) || visited.has(link.id)) return null;
  visited.add(link.id);
  const from = nodeOutputPoint(link.from);
  const to = linkEndpointPoint(link.to, visited);
  visited.delete(link.id);
  if (!to) return null;

  const path = link.from === link.to ? feedbackPath(link.from) : bezierPath(from, to);
  const midpoint = link.from === link.to ? feedbackMidpoint(link.from) : bezierPoint(from, to, 0.5);
  return { from, to, path, midpoint };
}

function sendGraph() {
  if (!synthNode) return;
  synthNode.port.postMessage({
    type: "graph",
    payload: {
      nodes: state.nodes.map(({ id, wave, frequencyMode, ratio, frequency }) => ({
        id,
        wave,
        frequencyMode,
        ratio,
        frequency,
      })),
      links: state.links.map((link) => ({
        id: link.id,
        from: link.from,
        to: link.to,
        amount: Number(link.amount),
        delay: Number(link.delay) || 0,
        pan: Number(link.pan) || 0,
        velocitySensitivity: Number(link.velocitySensitivity) || 0,
        modulationTarget: link.modulationTarget || "phase",
        drone: Boolean(link.drone),
        filter: { ...link.filter },
        envelope: { ...link.envelope },
      })),
      maxVoices: state.maxVoices,
      masterEffects: state.masterEffects,
    },
  });
}

async function ensureAudio() {
  if (!audioContext) {
    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule("./src/audio-worklet.js");
    synthNode = new AudioWorkletNode(audioContext, "visual-fm-engine", {
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    synthNode.connect(audioContext.destination);
    sendGraph();
  }

  if (synthNode && !recorderDestination) {
    recorderDestination = audioContext.createMediaStreamDestination();
    synthNode.connect(recorderDestination);
  }

  if (audioContext.state !== "running") {
    await audioContext.resume();
  }
  audioStatus.textContent = "Audio ready";
  audioStatus.classList.add("ready");
}

function mediaRecorderOptions() {
  if (!window.MediaRecorder) return null;
  const preferredTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
  return mimeType ? { mimeType } : {};
}

function setRecordingButtonState(isRecording) {
  recordButton.classList.toggle("recording", isRecording);
  recordButton.setAttribute("aria-label", isRecording ? "Stop recording" : "Start recording");
  recordButton.title = isRecording ? "Stop recording" : "Start recording";
}

function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
  ].join("_");
}

function recordingFileName(date = new Date()) {
  return `${slugifyPatchName(state.patchName || "visual-fm-patch")}-${timestampForFile(date)}.wav`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function writeString(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function audioBufferToWav(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRateValue = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const channels = Array.from({ length: channelCount }, (_, index) => audioBuffer.getChannelData(index));
  let offset = 44;

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRateValue, true);
  view.setUint32(28, sampleRateValue * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const sample = clamp(channels[channelIndex][sampleIndex], -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

async function exportRecording() {
  const sourceBlob = new Blob(recordingChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  if (!sourceBlob.size) return;

  const arrayBuffer = await sourceBlob.arrayBuffer();
  const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  downloadBlob(audioBufferToWav(decoded), recordingFileName(recordingStartedAt || new Date()));
}

async function startRecording() {
  const options = mediaRecorderOptions();
  if (options === null) {
    alert("Recording is not supported in this browser.");
    return;
  }

  await ensureAudio();
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
  if (mediaRecorder?.state === "recording") {
    stopRecording();
  } else {
    startRecording();
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
      <span class="anchor input" data-anchor="input" data-node-id="${node.id}" title="Input"></span>
      <div class="node-title">${escapeHtml(nodeName(node))}</div>
      <div class="node-meta"><span>${node.wave}</span><span>${nodeFrequencyLabel(node)}</span></div>
      <span class="anchor output" data-anchor="output" data-node-id="${node.id}" title="Output"></span>
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
    const anchor = document.createElementNS("http://www.w3.org/2000/svg", "circle");

    visible.setAttribute("d", geometry.path);
    visible.setAttribute("class", `wire ${link.to === "audio" ? "output" : ""} ${linkById(link.to) ? "link-mod" : ""} ${link.from === link.to ? "feedback" : ""} ${state.selected.type === "link" && state.selected.id === link.id ? "selected" : ""}`);

    hit.setAttribute("d", geometry.path);
    hit.setAttribute("class", "wire-hit");
    hit.addEventListener("click", (event) => {
      event.stopPropagation();
      select("link", link.id);
    });

    anchor.setAttribute("cx", geometry.midpoint.x);
    anchor.setAttribute("cy", geometry.midpoint.y);
    anchor.setAttribute("r", "8");
    anchor.setAttribute("class", `link-anchor input ${state.selected.type === "link" && state.selected.id === link.id ? "selected" : ""}`);
    anchor.dataset.linkId = link.id;
    anchor.addEventListener("click", (event) => {
      event.stopPropagation();
      select("link", link.id);
    });

    group.append(visible, hit, anchor);
    wireLayer.appendChild(group);
  }

  if (linkDrag) {
    const preview = document.createElementNS("http://www.w3.org/2000/svg", "path");
    preview.setAttribute("d", bezierPath(nodeOutputPoint(linkDrag.from), linkDrag.to));
    preview.setAttribute("class", "wire selected");
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
    const isFixedFrequency = node.frequencyMode === "fixed";
    const frequencyValue = isFixedFrequency ? node.frequency : node.ratio;
    const frequencyMin = 0;
    const frequencyMax = isFixedFrequency ? 12000 : 16;
    const frequencyStep = isFixedFrequency ? 0.01 : 0.001;

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
          ${WAVE_TYPES.map((wave) => `<option value="${wave}" ${node.wave === wave ? "selected" : ""}>${wave}</option>`).join("")}
        </select>
      </div>
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
      renderNodes();
      sendGraph();
      savePatch();
    });
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
    if (modulationTargets.length && !modulationTargets.includes(link.modulationTarget)) {
      link.modulationTarget = modulationTargets[0];
      sendGraph();
      savePatch();
    }
    const envelopeControls = link.drone ? "" : `
      <section class="effect-section">
        <div class="section-title">Envelope</div>
        ${drawAdsr(link.envelope)}
        ${adsrField("delay", "Delay", link.envelope.delay, 0, 4, link.id)}
        ${adsrField("attack", "Attack", link.envelope.attack, 0.001, 4, link.id)}
        ${adsrField("decay", "Decay", link.envelope.decay, 0.001, 4, link.id)}
        ${adsrField("sustain", "Sustain", link.envelope.sustain, 0, 1, link.id)}
        ${adsrField("release", "Release", link.envelope.release, 0.001, 6, link.id)}
      </section>
    `;

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
        ${parameterLabel("velocitySensitivity", "Velocity", "link", link.id, "velocitySensitivity")}
        <div class="field-row">
          <input id="velocitySensitivityRange" type="range" min="0" max="${VELOCITY_SENSITIVITY_MAX}" step="0.001" value="${link.velocitySensitivity}">
          <input id="velocitySensitivity" type="number" min="0" max="${VELOCITY_SENSITIVITY_MAX}" step="0.001" value="${link.velocitySensitivity}">
        </div>
      </div>
      <div class="field">
        ${parameterLabel("linkDelay", "Delay", "link", link.id, "delay")}
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
      </section>
    `;

    bindNumberPair("amount", "amountRange", 0, amountMax, (value) => {
      link.amount = value;
      sendGraph();
      savePatch();
    });

    if (link.to === "audio") {
      bindNumberPair("pan", "panRange", -1, 1, (value) => {
        link.pan = value;
        sendGraph();
        savePatch();
      });
    }

    bindNumberPair("velocitySensitivity", "velocitySensitivityRange", 0, VELOCITY_SENSITIVITY_MAX, (value) => {
      link.velocitySensitivity = value;
      sendGraph();
      savePatch();
    });

    bindNumberPair("linkDelay", "linkDelayRange", 0, 3, (value) => {
      link.delay = value;
      sendGraph();
      savePatch();
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
      sendGraph();
      savePatch();
    });

    bindNumberPair("filterCutoff", "filterCutoffRange", 20, 12000, (value) => {
      link.filter.cutoff = value;
      sendGraph();
      savePatch();
    });

    bindNumberPair("filterResonance", "filterResonanceRange", 0.1, 12, (value) => {
      link.filter.resonance = value;
      sendGraph();
      savePatch();
    });

    if (!link.drone) {
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
  const { chorus, delay, reverb } = state.masterEffects;
  panel.innerHTML = `
    <h1>Audio Out</h1>
    <p class="panel-subtitle">Master effects</p>
    ${effectSection("chorus", "Chorus", chorus, [
      ["rate", "Rate", 0.05, 6, "Hz"],
      ["depth", "Depth", 0.001, 0.04, "s"],
      ["mix", "Mix", 0, 1, ""],
    ])}
    ${effectSection("delay", "Delay", delay, [
      ["time", "Time", 0.02, 1.5, "s"],
      ["feedback", "Feedback", 0, 0.92, ""],
      ["mix", "Mix", 0, 1, ""],
    ])}
    ${effectSection("reverb", "Reverb", reverb, [
      ["size", "Size", 0.1, 1, ""],
      ["decay", "Decay", 0, 0.94, ""],
      ["mix", "Mix", 0, 1, ""],
    ])}
  `;

  for (const effectName of ["chorus", "delay", "reverb"]) {
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
}

function patchFileName() {
  const name = slugifyPatchName(state.patchName || "visual-fm-patch");
  return `${name}-${timestampForFile(new Date())}.yaml`;
}

function downloadPatch() {
  const patch = currentPatchData();
  const yaml = `# Visual FM patch\n# visual-fm-json: ${encodePatchJson(patch)}\n${toYaml(patch)}\n`;
  const blob = new Blob([yaml], { type: "application/x-yaml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = patchFileName();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
  savePatch();
}

function newPatch() {
  if (!confirm("Clear the current patch and start a new one? Unsaved changes will be lost.")) {
    return;
  }

  const midiChannel = state.midiChannel;
  const midiInputId = state.midiInputId;
  const normalized = normalizePatch(clonePatch(defaultPatch));
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
  savePatch();
}

function slugifyPatchName(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "visual-fm-patch";
}

function parsePatchFile(text) {
  const encoded = /^# visual-fm-json: (.+)$/m.exec(text)?.[1];
  if (encoded) {
    return JSON.parse(decodePatchJson(encoded.trim()));
  }

  try {
    return JSON.parse(text);
  } catch {
    return parseSimpleYaml(text);
  }
}

function encodePatchJson(patch) {
  const bytes = new TextEncoder().encode(JSON.stringify(patch));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodePatchJson(encoded) {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
      if (item && typeof item === "object") {
        return `${space}${key}:\n${toYaml(item, indent + 2)}`;
      }
      return `${space}${key}: ${yamlScalar(item)}`;
    }).join("\n");
  }

  return `${space}${yamlScalar(value)}`;
}

function yamlScalar(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function parseSimpleYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => ({ indent: raw.match(/^ */)?.[0].length || 0, text: raw.trim() }))
    .filter((line) => line.text && !line.text.startsWith("#"));

  const [value, index] = parseYamlBlock(lines, 0, 0);
  if (index < lines.length) throw new Error("Unsupported YAML structure");
  return value;
}

function parseYamlBlock(lines, index, indent) {
  if (!lines[index]) return [{}, index];
  if (lines[index].indent < indent) return [{}, index];
  return lines[index].text.startsWith("-")
    ? parseYamlArray(lines, index, indent)
    : parseYamlObject(lines, index, indent);
}

function parseYamlArray(lines, index, indent) {
  const array = [];
  while (lines[index] && lines[index].indent === indent && lines[index].text.startsWith("-")) {
    const inline = lines[index].text.slice(1).trim();
    index += 1;
    if (inline) {
      array.push(parseYamlScalar(inline));
    } else {
      const [item, nextIndex] = parseYamlBlock(lines, index, indent + 2);
      array.push(item);
      index = nextIndex;
    }
  }
  return [array, index];
}

function parseYamlObject(lines, index, indent) {
  const object = {};
  while (lines[index] && lines[index].indent === indent && !lines[index].text.startsWith("-")) {
    const separator = lines[index].text.indexOf(":");
    if (separator === -1) throw new Error("Invalid YAML line");
    const key = lines[index].text.slice(0, separator).trim();
    const inline = lines[index].text.slice(separator + 1).trim();
    index += 1;
    if (inline) {
      object[key] = parseYamlScalar(inline);
    } else {
      const [item, nextIndex] = parseYamlBlock(lines, index, indent + 2);
      object[key] = item;
      index = nextIndex;
    }
  }
  return [object, index];
}

function parseYamlScalar(value) {
  if (value === "[]") return [];
  if (value === "{}") return {};
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) return JSON.parse(value);
  return value;
}

function effectSection(id, title, effect, params) {
  return `
    <section class="effect-section">
      <label class="toggle-row" for="${id}Enabled">
        <span>${title}</span>
        <input id="${id}Enabled" type="checkbox" ${effect.enabled ? "checked" : ""}>
      </label>
      ${params.map(([key, label, min, max, unit]) => effectField(id, key, label, effect[key], min, max, unit)).join("")}
    </section>
  `;
}

function effectField(effectId, key, label, value, min, max, unit) {
  const id = `${effectId}-${key}`;
  const step = max <= 1 ? 0.001 : 0.01;
  return `
    <div class="field">
      <label for="${id}">${label}${unit ? ` (${unit})` : ""}</label>
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

function nodeFrequencyLabel(node) {
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
    filterResonance: "Resonance",
    amplitude: "Amplitude",
    delay: "Delay",
    pan: "Pan",
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

function adsrField(name, label, value, min, max, linkId) {
  return `
    <div class="field">
      ${parameterLabel(name, label, "link", linkId, `envelope.${name}`)}
      <div class="field-row">
        <input id="${name}Range" type="range" min="${min}" max="${max}" step="0.001" value="${value}">
        <input id="${name}" type="number" min="${min}" max="${max}" step="0.001" value="${value}">
      </div>
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
        <div class="midi-binding-item">
          <div class="midi-binding-copy">
            <strong>${escapeHtml(midiElementLabel(binding.targetType, binding.targetId))}</strong>
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

function attachMidiBindingEvents() {
  panel.querySelector("#newMidiBindingButton")?.addEventListener("click", () => openMidiBindingModal());
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

  return `
    ${nodeOptions ? `<optgroup label="Operators">${nodeOptions}</optgroup>` : ""}
    ${linkOptions ? `<optgroup label="Links">${linkOptions}</optgroup>` : ""}
  `;
}

function renderMidiParameterOptions(targetType, targetId, selectedParameter) {
  return midiParameterDefinitions(targetType, targetId).map((definition) => (
    `<option value="${escapeHtml(definition.id)}" ${selectedParameter === definition.id ? "selected" : ""}>${escapeHtml(definition.label)}</option>`
  )).join("");
}

function openMidiBindingModal(bindingId = null, preset = null) {
  const existing = state.midiBindings.find((binding) => binding.id === bindingId);
  const defaultTarget = existing
    || preset
    || (state.nodes[0] ? { targetType: "node", targetId: state.nodes[0].id, parameter: "wave", cc: 1 } : null)
    || (state.links[0] ? { targetType: "link", targetId: state.links[0].id, parameter: "amount", cc: 1 } : null);
  if (!defaultTarget) return;

  const selectedElementValue = midiElementValue(defaultTarget.targetType, defaultTarget.targetId);
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.innerHTML = `
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
  `;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("#midiBindingForm");
  const elementSelect = overlay.querySelector("#midiBindingElement");
  const parameterSelect = overlay.querySelector("#midiBindingParameter");
  const ccInput = overlay.querySelector("#midiBindingCc");
  const close = () => overlay.remove();
  const syncParameterOptions = (preferredParameter = "") => {
    const { targetType, targetId } = parseMidiElementValue(elementSelect.value);
    parameterSelect.innerHTML = renderMidiParameterOptions(targetType, targetId, preferredParameter);
  };

  syncParameterOptions(defaultTarget.parameter);
  if (!parameterSelect.value) syncParameterOptions();
  elementSelect.addEventListener("change", () => syncParameterOptions());
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
    const binding = {
      id: existing?.id || midiBindingUid(),
      targetType,
      targetId,
      parameter,
      cc: Number.isFinite(cc) ? cc : 0,
    };

    if (existing) {
      Object.assign(existing, binding);
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
      <div class="field">
        <label for="maxVoices">Max voices</label>
        <div class="field-row">
          <input id="maxVoicesRange" type="range" min="${MIN_MAX_VOICES}" max="${MAX_MAX_VOICES}" step="1" value="${state.maxVoices}">
          <input id="maxVoices" type="number" min="${MIN_MAX_VOICES}" max="${MAX_MAX_VOICES}" step="1" value="${state.maxVoices}">
        </div>
      </div>
      <div class="panel-actions">
        <button class="text-button" id="newPatchButton" type="button">New</button>
        <button class="text-button" id="savePatchButton" type="button">Save</button>
        <button class="text-button" id="loadPatchButton" type="button">Load</button>
        <input class="visually-hidden" id="loadPatchInput" type="file" accept=".yaml,.yml,.json,application/x-yaml,application/json">
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
    amount: to === "audio" ? 0.85 : 0.65,
    delay: 0,
    pan: 0,
    velocitySensitivity: to === "audio" ? 1 : 0,
    modulationTarget: to === "audio" ? "amplitude" : targetLink ? "filterCutoff" : "phase",
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
  renderNodes();
  renderWires();
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
  renderWires();
}

function onLinkPointerUp(event) {
  if (!linkDrag) return;
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const inputAnchor = target?.closest?.(".anchor.input");
  const audioAnchor = target?.closest?.(".audio-anchor, .audio-out");
  const linkAnchor = target?.closest?.(".link-anchor.input");

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
  renderWires();
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

stage.addEventListener("pointerdown", onStagePointerDown);

stage.addEventListener("dblclick", (event) => {
  if (event.target.closest?.(".node, .audio-out, .wire-hit, .link-anchor")) return;
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
