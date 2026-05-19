export const STORAGE_KEY = "visual-fm.patch.v1";

export const LINK_FILTER_TYPES = ["none", "lowpass", "highpass", "bandpass", "comb", "comb-notch", "formant"];
export const LINK_DISTORTION_TYPES = ["hard-clip", "soft-clip", "fuzz", "saturate", "wavefold"];
export const LINK_SIGNAL_MODES = ["raw", "envelope", "inverted-envelope"];
export const WAVE_TYPES = ["sine", "triangle", "saw", "ramp", "square", "sample-hold", "custom", "noise", "perlin", "audio-input"];
export const OSCILLATOR_WAVE_TYPES = ["sine", "triangle", "saw", "ramp", "square", "sample-hold", "custom"];
export const PITCHED_WAVE_TYPES = new Set(["sine", "triangle", "saw", "ramp", "square", "sample-hold", "custom"]);
export const DEFAULT_CUSTOM_WAVE = Object.freeze({
  mode: "loop",
  sustainStart: 0.5,
  sustainEnd: 0.75,
  points: Object.freeze([
    Object.freeze({ x: 0, y: 0 }),
    Object.freeze({ x: 1, y: 0 }),
  ]),
});
export const SPEED_WAVE_TYPES = new Set(["perlin"]);
export const FREQUENCY_MODES = ["ratio", "fixed"];
export const QUANTISE_ROOT_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const QUANTISE_SCALES = [
  "chromatic",
  "major",
  "minor",
  "major-pentatonic",
  "minor-pentatonic",
  "blues",
  "dorian",
  "mixolydian",
  "harmonic-minor",
];
export const DEFAULT_NODE_QUANTISE = { enabled: false, root: "C", scale: "chromatic", glide: 0 };
export const NODE_MODULATION_TARGETS = ["phase", "phaseResetTrigger", "frequency", "wave", "ring", "fold", "mix"];
export const LINK_MODULATION_TARGETS = [
  "amplitude",
  "pan",
  "noise",
  "delay",
  "envelopeTrigger",
  "envelope.delay",
  "envelope.attack",
  "envelope.decay",
  "envelope.sustain",
  "envelope.release",
  "filterCutoff",
  "filterResonance",
];

export const DEFAULT_LINK_FILTER = { type: "none", cutoff: 5000, resonance: 0.7 };
export const DEFAULT_LINK_DISTORTION = { enabled: false, type: "soft-clip", gain: 1.5 };
export const DEFAULT_LINK_FOLLOWER = { attack: 0.01, release: 0.12 };

export const MASTER_EFFECTS = {
  chorus: {
    label: "Chorus",
    params: [
      ["rate", "Rate", 0.05, 6, "Hz"],
      ["depth", "Depth", 0.001, 0.04, "s"],
      ["mix", "Mix", 0, 1, ""],
    ],
  },
  delay: {
    label: "Delay",
    params: [
      ["time", "Time", 0.02, 1.5, "s"],
      ["feedback", "Feedback", 0, 0.92, ""],
      ["mix", "Mix", 0, 1, ""],
    ],
  },
  reverb: {
    label: "Reverb",
    params: [
      ["size", "Size", 0.1, 1, ""],
      ["decay", "Decay", 0, 0.94, ""],
      ["mix", "Mix", 0, 1, ""],
    ],
  },
};
export const MASTER_EFFECT_IDS = Object.keys(MASTER_EFFECTS);

export const VELOCITY_SENSITIVITY_MIN = -8;
export const VELOCITY_SENSITIVITY_MAX = 8;
export const DEFAULT_MAX_VOICES = 5;
export const MIN_MAX_VOICES = 1;
export const MAX_MAX_VOICES = 16;
export const DEFAULT_AUDIO_DEVICE_ID = "default";

export const MIDI_CC_SMOOTH_SECONDS = 0.09;
export const MIDI_CC_SETTLE_RATIO = 0.00025;
export const MIDI_CC_MAX_SMOOTH_DT = 1 / 60;
export const RECENT_MIDI_CC_WINDOW_MS = 2000;
export const MIDI_CC_CURVES = ["linear", "logarithmic", "exponential"];

export const LINK_INPUT_T = 0.45;
export const NODE_MIDI_PARAMETERS = new Set([
  "wave",
  "frequencyMode",
  "ratio",
  "frequency",
  "quantise.enabled",
  "quantise.root",
  "quantise.scale",
  "quantise.glide",
  "speed",
  "audioInputGain",
]);
export const LINK_MIDI_PARAMETERS = new Set([
  "modulationTarget",
  "amount",
  "pan",
  "velocitySensitivity",
  "noise",
  "delay",
  "drone",
  "filter.enabled",
  "distortion.enabled",
  "signalMode",
  "follower.attack",
  "follower.release",
  "filter.type",
  "filter.cutoff",
  "filter.resonance",
  "distortion.type",
  "distortion.gain",
  "envelope.delay",
  "envelope.attack",
  "envelope.decay",
  "envelope.sustain",
  "envelope.release",
]);

export const defaultPatch = {
  patchName: "Visual FM Patch",
  maxVoices: DEFAULT_MAX_VOICES,
  audioInputDeviceId: DEFAULT_AUDIO_DEVICE_ID,
  audioOutputDeviceId: DEFAULT_AUDIO_DEVICE_ID,
  audioOutPosition: null,
  midiChannel: "all",
  midiInputId: "all",
  midiBindings: [],
  masterEffects: {
    chorus: { enabled: false, rate: 0.8, depth: 0.012, mix: 0.25 },
    delay: { enabled: false, time: 0.28, feedback: 0.35, mix: 0.25 },
    reverb: { enabled: false, size: 0.55, decay: 0.45, mix: 0.25 },
  },
  nodes: [
    { id: "op-1", name: "A", x: 260, y: 220, wave: "sine", frequencyMode: "ratio", ratio: 1, frequency: 440, quantise: { ...DEFAULT_NODE_QUANTISE }, speed: 8, audioInputGain: 1, customWave: DEFAULT_CUSTOM_WAVE },
    { id: "op-2", name: "B", x: 490, y: 180, wave: "sine", frequencyMode: "ratio", ratio: 2, frequency: 880, quantise: { ...DEFAULT_NODE_QUANTISE }, speed: 8, audioInputGain: 1, customWave: DEFAULT_CUSTOM_WAVE },
  ],
  links: [
    {
      id: "link-1",
      from: "op-2",
      to: "op-1",
      amount: 2,
      delay: 0,
      noise: 0,
      velocitySensitivity: 0,
      modulationTarget: "phase",
      drone: false,
      signalMode: "raw",
      follower: { ...DEFAULT_LINK_FOLLOWER },
      filter: { ...DEFAULT_LINK_FILTER },
      distortion: { ...DEFAULT_LINK_DISTORTION },
      envelope: { delay: 0, attack: 0.03, decay: 0.16, sustain: 0.65, release: 0.26 },
    },
    {
      id: "link-2",
      from: "op-1",
      to: "audio",
      amount: 1,
      delay: 0,
      noise: 0,
      pan: 0,
      velocitySensitivity: 1,
      modulationTarget: "amplitude",
      drone: false,
      signalMode: "raw",
      follower: { ...DEFAULT_LINK_FOLLOWER },
      filter: { ...DEFAULT_LINK_FILTER },
      distortion: { ...DEFAULT_LINK_DISTORTION },
      envelope: { delay: 0, attack: 0.01, decay: 0.18, sustain: 0.78, release: 0.32 },
    },
  ],
};

export const keyMap = new Map([
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
