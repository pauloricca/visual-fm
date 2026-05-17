const MAX_WASM_FRAMES: usize = 2048;
const MAX_NODES: usize = 512;
const MAX_LINKS: usize = 1024;
const MAX_VOICE_SLOTS: usize = 17;
const DRONE_VOICE_SLOT: usize = MAX_VOICE_SLOTS - 1;
const MAX_DELAY_SLOTS: usize = 96;
const MAX_DELAY_SAMPLES: usize = 8192;
const MAX_FORMANT_BANDS: usize = 3;
const MAX_CUSTOM_WAVE_POINTS: usize = 64;
const FORMANT_INTENSITY_MAX: f64 = 36.0;
const CUSTOM_ONESHOT_EDGE_FADE_SECONDS: f64 = 0.002;
const CUSTOM_MODE_LOOP: i32 = 0;
const CUSTOM_MODE_ONCE: i32 = 1;
const CUSTOM_MODE_PING_PONG: i32 = 2;
const CUSTOM_MODE_SUSTAIN: i32 = 3;
const CUSTOM_MODE_SUSTAIN_LOOP: i32 = 4;
const CUSTOM_MODE_SUSTAIN_PING_PONG: i32 = 5;
const AUDIO_TARGET: i32 = -1;
const LINK_TARGET_BASE: i32 = -2;
const TWO_PI: f64 = core::f64::consts::PI * 2.0;
const ENVELOPE_TRIGGER_THRESHOLD: f64 = 0.5;
const ENVELOPE_TRIGGER_REARM: f64 = 0.45;
const TARGET_FREQUENCY: i32 = 1;
const TARGET_RING: i32 = 2;
const TARGET_FOLD: i32 = 3;
const TARGET_MIX: i32 = 4;
const TARGET_WAVE: i32 = 5;
const TARGET_PHASE_RESET_TRIGGER: i32 = 6;
const TARGET_AMPLITUDE: i32 = 10;
const TARGET_PAN: i32 = 11;
const TARGET_NOISE: i32 = 12;
const TARGET_DELAY: i32 = 13;
const TARGET_ENVELOPE_TRIGGER: i32 = 14;
const TARGET_ENVELOPE_DELAY: i32 = 15;
const TARGET_ENVELOPE_ATTACK: i32 = 16;
const TARGET_ENVELOPE_DECAY: i32 = 17;
const TARGET_ENVELOPE_SUSTAIN: i32 = 18;
const TARGET_ENVELOPE_RELEASE: i32 = 19;
const TARGET_FILTER_CUTOFF: i32 = 20;
const TARGET_FILTER_RESONANCE: i32 = 21;

#[derive(Copy, Clone)]
struct Node {
    wave: i32,
    frequency_mode: i32,
    ratio: f64,
    frequency: f64,
    speed: f64,
    audio_input_gain: f64,
    custom_mode: i32,
    custom_sustain_start: f64,
    custom_sustain_end: f64,
}

#[derive(Copy, Clone)]
struct Link {
    from: i32,
    to: i32,
    amount: f64,
    delay: f64,
    noise: f64,
    pan: f64,
    target: i32,
    velocity_sensitivity: f64,
    drone: i32,
    signal_mode: i32,
    follower_attack: f64,
    follower_release: f64,
    filter_type: i32,
    filter_cutoff: f64,
    filter_resonance: f64,
    env_delay: f64,
    env_attack: f64,
    env_decay: f64,
    env_sustain: f64,
    env_release: f64,
}

const EMPTY_NODE: Node = Node {
    wave: 0,
    frequency_mode: 0,
    ratio: 1.0,
    frequency: 440.0,
    speed: 8.0,
    audio_input_gain: 1.0,
    custom_mode: CUSTOM_MODE_LOOP,
    custom_sustain_start: 0.5,
    custom_sustain_end: 0.75,
};

const EMPTY_LINK: Link = Link {
    from: -1,
    to: AUDIO_TARGET,
    amount: 0.0,
    delay: 0.0,
    noise: 0.0,
    pan: 0.0,
    target: 0,
    velocity_sensitivity: 0.0,
    drone: 0,
    signal_mode: 0,
    follower_attack: 0.01,
    follower_release: 0.12,
    filter_type: 0,
    filter_cutoff: 5000.0,
    filter_resonance: 0.7,
    env_delay: 0.0,
    env_attack: 0.01,
    env_decay: 0.16,
    env_sustain: 0.72,
    env_release: 0.24,
};

#[derive(Copy, Clone)]
struct FilterState {
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

#[derive(Copy, Clone)]
struct FormantBand {
    frequency: f64,
    q: f64,
    gain_db: f64,
}

const EMPTY_FILTER_STATE: FilterState = FilterState {
    x1: 0.0,
    x2: 0.0,
    y1: 0.0,
    y2: 0.0,
};

const FORMANT_VOWELS: [[FormantBand; MAX_FORMANT_BANDS]; 5] = [
    [
        FormantBand { frequency: 800.0, q: 7.5, gain_db: 0.0 },
        FormantBand { frequency: 1150.0, q: 9.0, gain_db: -5.0 },
        FormantBand { frequency: 2900.0, q: 12.0, gain_db: -13.0 },
    ],
    [
        FormantBand { frequency: 420.0, q: 7.5, gain_db: 0.0 },
        FormantBand { frequency: 1750.0, q: 12.0, gain_db: -4.0 },
        FormantBand { frequency: 2600.0, q: 13.0, gain_db: -12.0 },
    ],
    [
        FormantBand { frequency: 300.0, q: 8.5, gain_db: 0.0 },
        FormantBand { frequency: 2200.0, q: 14.0, gain_db: -3.0 },
        FormantBand { frequency: 3000.0, q: 15.0, gain_db: -10.0 },
    ],
    [
        FormantBand { frequency: 500.0, q: 8.0, gain_db: 0.0 },
        FormantBand { frequency: 900.0, q: 9.0, gain_db: -5.0 },
        FormantBand { frequency: 2500.0, q: 12.0, gain_db: -14.0 },
    ],
    [
        FormantBand { frequency: 350.0, q: 8.0, gain_db: 0.0 },
        FormantBand { frequency: 700.0, q: 9.0, gain_db: -7.0 },
        FormantBand { frequency: 2400.0, q: 12.0, gain_db: -16.0 },
    ],
];

static mut LEFT: [f32; MAX_WASM_FRAMES] = [0.0; MAX_WASM_FRAMES];
static mut RIGHT: [f32; MAX_WASM_FRAMES] = [0.0; MAX_WASM_FRAMES];
static mut INPUT: [f32; MAX_WASM_FRAMES] = [0.0; MAX_WASM_FRAMES];
static mut NODES: [Node; MAX_NODES] = [EMPTY_NODE; MAX_NODES];
static mut LINKS: [Link; MAX_LINKS] = [EMPTY_LINK; MAX_LINKS];
static mut NODE_COUNT: usize = 0;
static mut LINK_COUNT: usize = 0;
static mut PHASES: [[f64; MAX_NODES]; MAX_VOICE_SLOTS] = [[0.0; MAX_NODES]; MAX_VOICE_SLOTS];
static mut FEEDBACK: [[f64; MAX_NODES]; MAX_VOICE_SLOTS] = [[0.0; MAX_NODES]; MAX_VOICE_SLOTS];
static mut SAMPLE_HOLDS: [[f64; MAX_NODES]; MAX_VOICE_SLOTS] = [[0.0; MAX_NODES]; MAX_VOICE_SLOTS];
static mut SAMPLE_HOLD_SET: [[bool; MAX_NODES]; MAX_VOICE_SLOTS] =
    [[false; MAX_NODES]; MAX_VOICE_SLOTS];
static mut PERLIN_CURRENT: [[f64; MAX_NODES]; MAX_VOICE_SLOTS] =
    [[0.0; MAX_NODES]; MAX_VOICE_SLOTS];
static mut PERLIN_NEXT: [[f64; MAX_NODES]; MAX_VOICE_SLOTS] = [[0.0; MAX_NODES]; MAX_VOICE_SLOTS];
static mut PERLIN_SET: [[bool; MAX_NODES]; MAX_VOICE_SLOTS] = [[false; MAX_NODES]; MAX_VOICE_SLOTS];
static mut CUSTOM_WAVE_XS: [[f64; MAX_CUSTOM_WAVE_POINTS]; MAX_NODES] =
    [[0.0; MAX_CUSTOM_WAVE_POINTS]; MAX_NODES];
static mut CUSTOM_WAVE_YS: [[f64; MAX_CUSTOM_WAVE_POINTS]; MAX_NODES] =
    [[0.0; MAX_CUSTOM_WAVE_POINTS]; MAX_NODES];
static mut CUSTOM_WAVE_COUNTS: [usize; MAX_NODES] = [0; MAX_NODES];
static mut CUSTOM_WAVE_DONE: [[bool; MAX_NODES]; MAX_VOICE_SLOTS] =
    [[false; MAX_NODES]; MAX_VOICE_SLOTS];
static mut CUSTOM_WAVE_DIRECTIONS: [[f64; MAX_NODES]; MAX_VOICE_SLOTS] =
    [[1.0; MAX_NODES]; MAX_VOICE_SLOTS];
static mut LINK_DELAY_SLOTS: [i32; MAX_LINKS] = [-1; MAX_LINKS];
static mut LINK_DELAY_SLOT_COUNT: usize = 0;
static mut LINK_FIRST_MODULATOR: [i32; MAX_LINKS] = [-1; MAX_LINKS];
static mut LINK_NEXT_MODULATOR: [i32; MAX_LINKS] = [-1; MAX_LINKS];
static mut LINK_HAS_ENVELOPE_TRIGGER: [bool; MAX_LINKS] = [false; MAX_LINKS];
static mut LINK_DELAY_BUFFERS: [[[f32; MAX_DELAY_SAMPLES]; MAX_DELAY_SLOTS]; MAX_VOICE_SLOTS] =
    [[[0.0; MAX_DELAY_SAMPLES]; MAX_DELAY_SLOTS]; MAX_VOICE_SLOTS];
static mut LINK_DELAY_INDICES: [[usize; MAX_DELAY_SLOTS]; MAX_VOICE_SLOTS] =
    [[0; MAX_DELAY_SLOTS]; MAX_VOICE_SLOTS];
static mut LINK_DELAY_READY: [[bool; MAX_DELAY_SLOTS]; MAX_VOICE_SLOTS] =
    [[false; MAX_DELAY_SLOTS]; MAX_VOICE_SLOTS];
static mut LINK_TRIGGER_ARMED: [[bool; MAX_LINKS]; MAX_VOICE_SLOTS] =
    [[true; MAX_LINKS]; MAX_VOICE_SLOTS];
static mut LINK_TRIGGER_START_AGE: [[f64; MAX_LINKS]; MAX_VOICE_SLOTS] =
    [[-1.0; MAX_LINKS]; MAX_VOICE_SLOTS];
static mut LINK_FOLLOWERS: [[f64; MAX_LINKS]; MAX_VOICE_SLOTS] =
    [[0.0; MAX_LINKS]; MAX_VOICE_SLOTS];
static mut LINK_FILTERS: [[FilterState; MAX_LINKS]; MAX_VOICE_SLOTS] =
    [[EMPTY_FILTER_STATE; MAX_LINKS]; MAX_VOICE_SLOTS];
static mut LINK_FORMANT_FILTERS: [[[FilterState; MAX_FORMANT_BANDS]; MAX_LINKS]; MAX_VOICE_SLOTS] =
    [[[EMPTY_FILTER_STATE; MAX_FORMANT_BANDS]; MAX_LINKS]; MAX_VOICE_SLOTS];
static mut RNG_STATES: [u32; MAX_VOICE_SLOTS] = [
    0x1234_5678,
    0x2345_6789,
    0x3456_789a,
    0x4567_89ab,
    0x5678_9abc,
    0x6789_abcd,
    0x789a_bcde,
    0x89ab_cdef,
    0x9abc_def0,
    0xabcd_ef01,
    0xbcde_f012,
    0xcdef_0123,
    0xdef0_1234,
    0xef01_2345,
    0xf012_3456,
    0x1020_3040,
    0x5060_7080,
];
static mut FREQUENCY_MODS: [f64; MAX_NODES] = [0.0; MAX_NODES];
static mut RENDER_CACHE: [f64; MAX_NODES] = [0.0; MAX_NODES];
static mut CACHE_STAMPS: [u32; MAX_NODES] = [0; MAX_NODES];
static mut RENDER_STACK: [bool; MAX_NODES] = [false; MAX_NODES];
static mut LINK_PARAM_STACK: [bool; MAX_LINKS] = [false; MAX_LINKS];
static mut LINK_METER_INPUT_SUMS: [f64; MAX_LINKS] = [0.0; MAX_LINKS];
static mut LINK_METER_OUTPUT_SUMS: [f64; MAX_LINKS] = [0.0; MAX_LINKS];
static mut LINK_METER_ENVELOPE_SUMS: [f64; MAX_LINKS] = [0.0; MAX_LINKS];
static mut LINK_METER_COUNTS: [u32; MAX_LINKS] = [0; MAX_LINKS];
static mut CURRENT_STAMP: u32 = 1;

#[no_mangle]
pub extern "C" fn leftPtr() -> *const f32 {
    core::ptr::addr_of!(LEFT).cast::<f32>()
}

#[no_mangle]
pub extern "C" fn rightPtr() -> *const f32 {
    core::ptr::addr_of!(RIGHT).cast::<f32>()
}

#[no_mangle]
pub extern "C" fn inputPtr() -> *mut f32 {
    core::ptr::addr_of_mut!(INPUT).cast::<f32>()
}

#[no_mangle]
pub extern "C" fn linkMeterInputPtr() -> *const f64 {
    core::ptr::addr_of!(LINK_METER_INPUT_SUMS).cast::<f64>()
}

#[no_mangle]
pub extern "C" fn linkMeterOutputPtr() -> *const f64 {
    core::ptr::addr_of!(LINK_METER_OUTPUT_SUMS).cast::<f64>()
}

#[no_mangle]
pub extern "C" fn linkMeterEnvelopePtr() -> *const f64 {
    core::ptr::addr_of!(LINK_METER_ENVELOPE_SUMS).cast::<f64>()
}

#[no_mangle]
pub extern "C" fn linkMeterCountPtr() -> *const u32 {
    core::ptr::addr_of!(LINK_METER_COUNTS).cast::<u32>()
}

#[no_mangle]
pub extern "C" fn clear(frames: u32) {
    let frames = (frames as usize).min(MAX_WASM_FRAMES);
    let left = core::ptr::addr_of_mut!(LEFT).cast::<f32>();
    let right = core::ptr::addr_of_mut!(RIGHT).cast::<f32>();

    for index in 0..frames {
        unsafe {
            *left.add(index) = 0.0;
            *right.add(index) = 0.0;
        }
    }
}

#[no_mangle]
pub extern "C" fn clearGraph() {
    unsafe {
        NODE_COUNT = 0;
        LINK_COUNT = 0;
        LINK_DELAY_SLOT_COUNT = 0;
        for index in 0..MAX_LINKS {
            LINK_DELAY_SLOTS[index] = -1;
            LINK_FIRST_MODULATOR[index] = -1;
            LINK_NEXT_MODULATOR[index] = -1;
            LINK_HAS_ENVELOPE_TRIGGER[index] = false;
        }
        for index in 0..MAX_NODES {
            CUSTOM_WAVE_COUNTS[index] = 0;
        }
    }
}

#[no_mangle]
pub extern "C" fn clearLinkMeters() {
    unsafe {
        for index in 0..MAX_LINKS {
            LINK_METER_INPUT_SUMS[index] = 0.0;
            LINK_METER_OUTPUT_SUMS[index] = 0.0;
            LINK_METER_ENVELOPE_SUMS[index] = 0.0;
            LINK_METER_COUNTS[index] = 0;
        }
    }
}

#[no_mangle]
pub extern "C" fn addNode(
    wave: i32,
    frequency_mode: i32,
    ratio: f64,
    frequency: f64,
    speed: f64,
    audio_input_gain: f64,
    custom_mode: i32,
    custom_sustain_start: f64,
    custom_sustain_end: f64,
) -> i32 {
    unsafe {
        if NODE_COUNT >= MAX_NODES {
            return -1;
        }
        let index = NODE_COUNT;
        NODES[index] = Node {
            wave,
            frequency_mode,
            ratio: ratio.clamp(0.0, 16.0),
            frequency: frequency.clamp(0.0, 12_000.0),
            speed: speed.clamp(0.01, 60.0),
            audio_input_gain: audio_input_gain.clamp(0.0, 4.0),
            custom_mode: custom_mode.clamp(CUSTOM_MODE_LOOP, CUSTOM_MODE_SUSTAIN_PING_PONG),
            custom_sustain_start: custom_sustain_start.clamp(0.0, 0.999),
            custom_sustain_end: custom_sustain_end.clamp((custom_sustain_start + 0.001).clamp(0.001, 1.0), 1.0),
        };
        CUSTOM_WAVE_COUNTS[index] = 0;
        NODE_COUNT += 1;
        index as i32
    }
}

#[no_mangle]
pub extern "C" fn addCustomWavePoint(node_index: i32, x: f64, y: f64) -> i32 {
    unsafe {
        if node_index < 0 || node_index as usize >= NODE_COUNT {
            return -1;
        }
        let node_index = node_index as usize;
        let count = CUSTOM_WAVE_COUNTS[node_index];
        if count >= MAX_CUSTOM_WAVE_POINTS {
            return -1;
        }
        CUSTOM_WAVE_XS[node_index][count] = x.clamp(0.0, 1.0);
        CUSTOM_WAVE_YS[node_index][count] = y.clamp(-1.0, 1.0);
        CUSTOM_WAVE_COUNTS[node_index] = count + 1;
        count as i32
    }
}

#[no_mangle]
pub extern "C" fn addLink(
    from: i32,
    to: i32,
    amount: f64,
    delay: f64,
    noise: f64,
    pan: f64,
    target: i32,
    velocity_sensitivity: f64,
    drone: i32,
    signal_mode: i32,
    follower_attack: f64,
    follower_release: f64,
    filter_type: i32,
    filter_cutoff: f64,
    filter_resonance: f64,
    env_delay: f64,
    env_attack: f64,
    env_decay: f64,
    env_sustain: f64,
    env_release: f64,
) -> i32 {
    unsafe {
        if LINK_COUNT >= MAX_LINKS || from < 0 || from as usize >= NODE_COUNT {
            return -1;
        }
        if to >= 0 && to as usize >= NODE_COUNT {
            return -1;
        }
        if to < AUDIO_TARGET {
            let target_index = link_target_index(to);
            if target_index.is_none() || target_index.unwrap() >= MAX_LINKS {
                return -1;
            }
        } else if to != AUDIO_TARGET && to < 0 {
            return -1;
        }
        let index = LINK_COUNT;
        LINKS[index] = Link {
            from,
            to,
            amount: amount.clamp(0.0, 32.0),
            delay: delay.clamp(0.0, 3.0),
            noise: noise.clamp(0.0, 1.0),
            pan: pan.clamp(-1.0, 1.0),
            target,
            velocity_sensitivity: velocity_sensitivity.clamp(-8.0, 8.0),
            drone,
            signal_mode,
            follower_attack: follower_attack.clamp(0.001, 2.0),
            follower_release: follower_release.clamp(0.001, 4.0),
            filter_type,
            filter_cutoff: if filter_type == 4 {
                filter_cutoff.clamp(0.0, 1.0)
            } else {
                filter_cutoff.clamp(20.0, 12_000.0)
            },
            filter_resonance: filter_resonance.clamp(
                0.1,
                if filter_type == 4 { FORMANT_INTENSITY_MAX } else { 12.0 },
            ),
            env_delay: env_delay.clamp(0.0, 4.0),
            env_attack: env_attack.clamp(0.001, 4.0),
            env_decay: env_decay.clamp(0.001, 4.0),
            env_sustain: env_sustain.clamp(0.0, 1.0),
            env_release: env_release.clamp(0.001, 6.0),
        };
        if let Some(target_index) = link_target_index(to) {
            if target_index < MAX_LINKS {
                LINK_NEXT_MODULATOR[index] = LINK_FIRST_MODULATOR[target_index];
                LINK_FIRST_MODULATOR[target_index] = index as i32;
                if target == TARGET_ENVELOPE_TRIGGER {
                    LINK_HAS_ENVELOPE_TRIGGER[target_index] = true;
                }
            }
        }
        LINK_COUNT += 1;
        index as i32
    }
}

#[no_mangle]
pub extern "C" fn setLinkNoise(index: u32, noise: f64) {
    unsafe {
        if (index as usize) < LINK_COUNT {
            LINKS[index as usize].noise = noise.clamp(0.0, 1.0);
        }
    }
}

#[no_mangle]
pub extern "C" fn setLinkVelocitySensitivity(index: u32, velocity_sensitivity: f64) {
    unsafe {
        if (index as usize) < LINK_COUNT {
            LINKS[index as usize].velocity_sensitivity = velocity_sensitivity.clamp(-8.0, 8.0);
        }
    }
}

#[no_mangle]
pub extern "C" fn setLinkFilterCutoff(index: u32, cutoff: f64) {
    unsafe {
        if (index as usize) < LINK_COUNT {
            LINKS[index as usize].filter_cutoff = if LINKS[index as usize].filter_type == 4 {
                cutoff.clamp(0.0, 1.0)
            } else {
                cutoff.clamp(20.0, 12_000.0)
            };
        }
    }
}

#[no_mangle]
pub extern "C" fn setLinkFilterResonance(index: u32, resonance: f64) {
    unsafe {
        if (index as usize) < LINK_COUNT {
            LINKS[index as usize].filter_resonance = resonance.clamp(
                0.1,
                if LINKS[index as usize].filter_type == 4 {
                    FORMANT_INTENSITY_MAX
                } else {
                    12.0
                },
            );
        }
    }
}

#[no_mangle]
pub extern "C" fn setLinkAmount(index: u32, amount: f64) {
    unsafe {
        if (index as usize) < LINK_COUNT {
            LINKS[index as usize].amount = amount.clamp(0.0, 32.0);
        }
    }
}

#[no_mangle]
pub extern "C" fn setLinkDelay(index: u32, delay: f64) {
    unsafe {
        if (index as usize) < LINK_COUNT {
            LINKS[index as usize].delay = delay.clamp(0.0, 3.0);
        }
    }
}

#[no_mangle]
pub extern "C" fn setLinkPan(index: u32, pan: f64) {
    unsafe {
        if (index as usize) < LINK_COUNT {
            LINKS[index as usize].pan = pan.clamp(-1.0, 1.0);
        }
    }
}

#[no_mangle]
pub extern "C" fn resetPhases() {
    let phases = core::ptr::addr_of_mut!(PHASES).cast::<f64>();
    let feedback = core::ptr::addr_of_mut!(FEEDBACK).cast::<f64>();
    let sample_holds = core::ptr::addr_of_mut!(SAMPLE_HOLDS).cast::<f64>();
    let sample_hold_set = core::ptr::addr_of_mut!(SAMPLE_HOLD_SET).cast::<bool>();
    let perlin_current = core::ptr::addr_of_mut!(PERLIN_CURRENT).cast::<f64>();
    let perlin_next = core::ptr::addr_of_mut!(PERLIN_NEXT).cast::<f64>();
    let perlin_set = core::ptr::addr_of_mut!(PERLIN_SET).cast::<bool>();
    let custom_wave_done = core::ptr::addr_of_mut!(CUSTOM_WAVE_DONE).cast::<bool>();
    let custom_wave_directions = core::ptr::addr_of_mut!(CUSTOM_WAVE_DIRECTIONS).cast::<f64>();
    let delay_buffers = core::ptr::addr_of_mut!(LINK_DELAY_BUFFERS).cast::<f32>();
    let delay_indices = core::ptr::addr_of_mut!(LINK_DELAY_INDICES).cast::<usize>();
    let delay_ready = core::ptr::addr_of_mut!(LINK_DELAY_READY).cast::<bool>();
    let trigger_armed = core::ptr::addr_of_mut!(LINK_TRIGGER_ARMED).cast::<bool>();
    let trigger_start_age = core::ptr::addr_of_mut!(LINK_TRIGGER_START_AGE).cast::<f64>();
    let followers = core::ptr::addr_of_mut!(LINK_FOLLOWERS).cast::<f64>();
    let filters = core::ptr::addr_of_mut!(LINK_FILTERS).cast::<FilterState>();
    let formant_filters = core::ptr::addr_of_mut!(LINK_FORMANT_FILTERS).cast::<FilterState>();
    let link_stack = core::ptr::addr_of_mut!(LINK_PARAM_STACK).cast::<bool>();
    let total = MAX_VOICE_SLOTS * MAX_NODES;
    for index in 0..total {
        unsafe {
            *phases.add(index) = 0.0;
            *feedback.add(index) = 0.0;
            *sample_holds.add(index) = 0.0;
            *sample_hold_set.add(index) = false;
            *perlin_current.add(index) = 0.0;
            *perlin_next.add(index) = 0.0;
            *perlin_set.add(index) = false;
            *custom_wave_done.add(index) = false;
            *custom_wave_directions.add(index) = 1.0;
        }
    }
    for index in 0..(MAX_VOICE_SLOTS * MAX_LINKS) {
        unsafe {
            *followers.add(index) = 0.0;
            *filters.add(index) = EMPTY_FILTER_STATE;
            *trigger_armed.add(index) = true;
            *trigger_start_age.add(index) = -1.0;
        }
    }
    for index in 0..(MAX_VOICE_SLOTS * MAX_LINKS * MAX_FORMANT_BANDS) {
        unsafe {
            *formant_filters.add(index) = EMPTY_FILTER_STATE;
        }
    }
    for index in 0..(MAX_VOICE_SLOTS * MAX_DELAY_SLOTS) {
        unsafe {
            *delay_indices.add(index) = 0;
            *delay_ready.add(index) = false;
        }
    }
    for index in 0..(MAX_VOICE_SLOTS * MAX_DELAY_SLOTS * MAX_DELAY_SAMPLES) {
        unsafe {
            *delay_buffers.add(index) = 0.0;
        }
    }
    for index in 0..MAX_LINKS {
        unsafe {
            *link_stack.add(index) = false;
        }
    }
}

#[no_mangle]
pub extern "C" fn resetVoiceSlot(voice_slot: u32) {
    let voice_slot = voice_slot as usize;
    if voice_slot >= MAX_VOICE_SLOTS {
        return;
    }
    unsafe {
        for node_index in 0..MAX_NODES {
            PHASES[voice_slot][node_index] = 0.0;
            FEEDBACK[voice_slot][node_index] = 0.0;
            SAMPLE_HOLDS[voice_slot][node_index] = 0.0;
            SAMPLE_HOLD_SET[voice_slot][node_index] = false;
            PERLIN_CURRENT[voice_slot][node_index] = 0.0;
            PERLIN_NEXT[voice_slot][node_index] = 0.0;
            PERLIN_SET[voice_slot][node_index] = false;
            CUSTOM_WAVE_DONE[voice_slot][node_index] = false;
            CUSTOM_WAVE_DIRECTIONS[voice_slot][node_index] = 1.0;
        }
        for link_index in 0..MAX_LINKS {
            LINK_TRIGGER_ARMED[voice_slot][link_index] = true;
            LINK_TRIGGER_START_AGE[voice_slot][link_index] = -1.0;
            LINK_FOLLOWERS[voice_slot][link_index] = 0.0;
            LINK_FILTERS[voice_slot][link_index] = EMPTY_FILTER_STATE;
            for band_index in 0..MAX_FORMANT_BANDS {
                LINK_FORMANT_FILTERS[voice_slot][link_index][band_index] = EMPTY_FILTER_STATE;
            }
        }
        for slot_index in 0..MAX_DELAY_SLOTS {
            LINK_DELAY_INDICES[voice_slot][slot_index] = 0;
            LINK_DELAY_READY[voice_slot][slot_index] = false;
            for sample_index in 0..MAX_DELAY_SAMPLES {
                LINK_DELAY_BUFFERS[voice_slot][slot_index][sample_index] = 0.0;
            }
        }
    }
}

fn next_stamp() -> u32 {
    unsafe {
        CURRENT_STAMP = CURRENT_STAMP.wrapping_add(1);
        if CURRENT_STAMP == 0 {
            let stamps = core::ptr::addr_of_mut!(CACHE_STAMPS).cast::<u32>();
            for index in 0..MAX_NODES {
                *stamps.add(index) = 0;
            }
            CURRENT_STAMP = 1;
        }
        CURRENT_STAMP
    }
}

fn normalize_phase(phase: f64) -> f64 {
    phase - phase.floor()
}

fn link_target_index(target: i32) -> Option<usize> {
    if target <= LINK_TARGET_BASE {
        Some((LINK_TARGET_BASE - target) as usize)
    } else {
        None
    }
}

fn observe_link_meter(link_index: usize, input: f64, output: f64, envelope: f64) {
    unsafe {
        if link_index >= MAX_LINKS {
            return;
        }
        LINK_METER_INPUT_SUMS[link_index] += input.abs().clamp(0.0, 1.0);
        LINK_METER_OUTPUT_SUMS[link_index] += output.abs().clamp(0.0, 1.0);
        LINK_METER_ENVELOPE_SUMS[link_index] += envelope.abs().clamp(0.0, 1.0);
        LINK_METER_COUNTS[link_index] = LINK_METER_COUNTS[link_index].saturating_add(1);
    }
}

fn smooth_step(t: f64) -> f64 {
    let x = t.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

fn oscillator(
    node_index: usize,
    node: Node,
    phase: f64,
    voice_slot: usize,
    frame: usize,
    wave: i32,
) -> f64 {
    let p = normalize_phase(phase);
    match wave {
        1 => 1.0 - 4.0 * ((p - 0.25).round() - (p - 0.25)).abs(),
        2 => p * 2.0 - 1.0,
        3 => 1.0 - p * 2.0,
        4 => {
            if p < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
        5 => unsafe {
            if !SAMPLE_HOLD_SET[voice_slot][node_index] {
                SAMPLE_HOLDS[voice_slot][node_index] = random_bipolar(voice_slot);
                SAMPLE_HOLD_SET[voice_slot][node_index] = true;
            }
            SAMPLE_HOLDS[voice_slot][node_index]
        },
        6 => random_bipolar(voice_slot),
        7 => unsafe {
            if !PERLIN_SET[voice_slot][node_index] {
                PERLIN_CURRENT[voice_slot][node_index] = random_bipolar(voice_slot);
                PERLIN_NEXT[voice_slot][node_index] = random_bipolar(voice_slot);
                PERLIN_SET[voice_slot][node_index] = true;
            }
            let current = PERLIN_CURRENT[voice_slot][node_index];
            let next = PERLIN_NEXT[voice_slot][node_index];
            current + (next - current) * smooth_step(p)
        },
        8 => unsafe { INPUT[frame.min(MAX_WASM_FRAMES - 1)] as f64 * node.audio_input_gain },
        9 => custom_wave_value(node_index, p),
        _ => (TWO_PI * p).sin(),
    }
}

fn modulated_wave(base_wave: i32, modulation: f64) -> i32 {
    if !modulation.is_finite() {
        return base_wave;
    }
    let waves = [0, 1, 2, 3, 4, 5, 9];
    let base_index = match waves.iter().position(|wave| *wave == base_wave) {
        Some(index) => index as i32,
        None => return base_wave,
    };
    let index = ((base_index as f64 + modulation).round() as i32)
        .clamp(0, (waves.len() - 1) as i32) as usize;
    waves[index]
}

fn custom_wave_value(node_index: usize, phase: f64) -> f64 {
    unsafe {
        let count = CUSTOM_WAVE_COUNTS[node_index];
        if count < 2 {
            return 0.0;
        }
        let p = phase.clamp(0.0, 1.0);
        for point_index in 1..count {
            let previous_x = CUSTOM_WAVE_XS[node_index][point_index - 1];
            let previous_y = CUSTOM_WAVE_YS[node_index][point_index - 1];
            let next_x = CUSTOM_WAVE_XS[node_index][point_index];
            let next_y = CUSTOM_WAVE_YS[node_index][point_index];
            if p > next_x && point_index < count - 1 {
                continue;
            }
            let span = next_x - previous_x;
            if span <= 0.0 {
                return next_y;
            }
            let t = ((p - previous_x) / span).clamp(0.0, 1.0);
            return previous_y + (next_y - previous_y) * t;
        }
        CUSTOM_WAVE_YS[node_index][count - 1]
    }
}

fn custom_one_shot_edge_gain(node: Node, phase: f64, base_frequency: f64) -> f64 {
    if node.wave != 9 || !custom_mode_is_finite(node.custom_mode) || base_frequency <= 0.0 {
        return 1.0;
    }
    let fade_phase = (CUSTOM_ONESHOT_EDGE_FADE_SECONDS * base_frequency).clamp(0.0005, 0.08);
    let p = phase.clamp(0.0, 1.0);
    (p / fade_phase).min((1.0 - p) / fade_phase).clamp(0.0, 1.0)
}

fn custom_mode_is_finite(mode: i32) -> bool {
    matches!(
        mode,
        CUSTOM_MODE_ONCE
            | CUSTOM_MODE_SUSTAIN
            | CUSTOM_MODE_SUSTAIN_LOOP
            | CUSTOM_MODE_SUSTAIN_PING_PONG
    )
}

fn fold_sample(sample: f64, drive: f64) -> f64 {
    let wrapped = ((sample * drive + 1.0) % 4.0 + 4.0) % 4.0;
    if wrapped <= 2.0 {
        wrapped - 1.0
    } else {
        3.0 - wrapped
    }
}

fn sanitize_sample(value: f64, limit: f64) -> f64 {
    if value.is_finite() {
        value.clamp(-limit, limit)
    } else {
        0.0
    }
}

fn pan_gains(pan: f64) -> (f64, f64) {
    let angle = (pan.clamp(-1.0, 1.0) + 1.0) * core::f64::consts::PI * 0.25;
    (angle.cos(), angle.sin())
}

fn base_frequency(node: Node, note_frequency: f64) -> f64 {
    if node.frequency_mode == 1 {
        node.frequency
    } else {
        note_frequency * node.ratio
    }
}

fn velocity_scale(velocity_sensitivity: f64, velocity: f64) -> f64 {
    if velocity_sensitivity == 0.0 {
        return 1.0;
    }
    let velocity = velocity.clamp(0.0, 1.0);
    if velocity_sensitivity < 0.0 {
        let inverted = (1.0 - velocity).clamp(0.0, 1.0);
        let depth = velocity_sensitivity.abs();
        if depth <= 1.0 {
            1.0 - depth + depth * inverted
        } else {
            inverted.powf(depth)
        }
    } else if velocity_sensitivity == 1.0 {
        velocity
    } else if velocity_sensitivity <= 1.0 {
        1.0 - velocity_sensitivity + velocity_sensitivity * velocity
    } else {
        velocity.powf(velocity_sensitivity)
    }
}

fn attack_curve(t: f64) -> f64 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

fn decay_curve(t: f64) -> f64 {
    (1.0 - t.clamp(0.0, 1.0)).powi(2)
}

fn held_envelope_value(link: Link, age: f64) -> f64 {
    if link.drone != 0 {
        return 1.0;
    }

    let mut elapsed = age.max(0.0);
    if elapsed < link.env_delay {
        return 0.0;
    }
    elapsed -= link.env_delay;

    if elapsed < link.env_attack {
        return attack_curve(elapsed / link.env_attack);
    }
    if elapsed < link.env_attack + link.env_decay {
        let t = (elapsed - link.env_attack) / link.env_decay;
        return link.env_sustain + (1.0 - link.env_sustain) * decay_curve(t);
    }
    link.env_sustain
}

fn envelope_value(link: Link, age: f64, release_age: f64) -> f64 {
    if link.drone != 0 {
        return 1.0;
    }
    if release_age < 0.0 {
        return held_envelope_value(link, age);
    }

    let release_started_age = (age - release_age).max(0.0);
    let release_level = held_envelope_value(link, release_started_age);
    release_level * decay_curve(release_age / link.env_release.max(0.001))
}

fn link_has_envelope_trigger(link_index: usize) -> bool {
    unsafe { link_index < MAX_LINKS && LINK_HAS_ENVELOPE_TRIGGER[link_index] }
}

fn triggered_envelope_value(
    link_index: usize,
    link: Link,
    voice_slot: usize,
    age: f64,
    release_age: f64,
) -> f64 {
    if link.drone != 0 {
        return 1.0;
    }
    let has_envelope_trigger = link_has_envelope_trigger(link_index);
    if voice_slot == DRONE_VOICE_SLOT && !has_envelope_trigger {
        return 0.0;
    }
    if !has_envelope_trigger {
        return envelope_value(link, age, release_age);
    }

    unsafe {
        let start_age = LINK_TRIGGER_START_AGE[voice_slot][link_index];
        if start_age < 0.0 || age < start_age {
            return 0.0;
        }
        envelope_value(link, age - start_age, release_age)
    }
}

fn apply_envelope_trigger(
    target_link_index: usize,
    mod_link_index: usize,
    voice_slot: usize,
    age: f64,
    value: f64,
) {
    if !value.is_finite() {
        return;
    }

    unsafe {
        let armed = LINK_TRIGGER_ARMED[voice_slot][mod_link_index];
        if armed && value >= ENVELOPE_TRIGGER_THRESHOLD {
            LINK_TRIGGER_START_AGE[voice_slot][target_link_index] = age;
            LINK_TRIGGER_ARMED[voice_slot][mod_link_index] = false;
        } else if !armed && value <= ENVELOPE_TRIGGER_REARM {
            LINK_TRIGGER_ARMED[voice_slot][mod_link_index] = true;
        }
    }
}

fn apply_phase_reset_trigger(
    target_node_index: usize,
    mod_link_index: usize,
    voice_slot: usize,
    value: f64,
) {
    if !value.is_finite() {
        return;
    }

    unsafe {
        let armed = LINK_TRIGGER_ARMED[voice_slot][mod_link_index];
        if armed && value >= ENVELOPE_TRIGGER_THRESHOLD {
            PHASES[voice_slot][target_node_index] = 0.0;
            CUSTOM_WAVE_DONE[voice_slot][target_node_index] = false;
            CUSTOM_WAVE_DIRECTIONS[voice_slot][target_node_index] = 1.0;
            LINK_TRIGGER_ARMED[voice_slot][mod_link_index] = false;
        } else if !armed && value <= ENVELOPE_TRIGGER_REARM {
            LINK_TRIGGER_ARMED[voice_slot][mod_link_index] = true;
        }
    }
}

fn random_bipolar(voice_slot: usize) -> f64 {
    unsafe {
        let state = RNG_STATES[voice_slot]
            .wrapping_mul(1_664_525)
            .wrapping_add(1_013_904_223);
        RNG_STATES[voice_slot] = state;
        (state as f64 / u32::MAX as f64) * 2.0 - 1.0
    }
}

fn apply_link_noise(sample: f64, link: Link, voice_slot: usize) -> f64 {
    if link.noise <= 0.0 {
        return sanitize_sample(sample, 4.0);
    }
    sanitize_sample(sample + random_bipolar(voice_slot) * link.noise, 4.0)
}

fn filter_coefficients(filter_type: i32, cutoff: f64, q: f64, sample_rate: f64) -> (f64, f64, f64, f64, f64) {
    let cutoff = cutoff.clamp(20.0, sample_rate * 0.45);
    let q = q.clamp(0.1, 96.0);
    let omega = TWO_PI * cutoff / sample_rate;
    let sin = omega.sin();
    let cos = omega.cos();
    let alpha = sin / (2.0 * q);
    let mut b0 = 1.0;
    let mut b1 = 0.0;
    let mut b2 = 0.0;
    let a0 = 1.0 + alpha;
    let a1 = -2.0 * cos;
    let a2 = 1.0 - alpha;

    if filter_type == 1 {
        b0 = (1.0 - cos) * 0.5;
        b1 = 1.0 - cos;
        b2 = (1.0 - cos) * 0.5;
    } else if filter_type == 2 {
        b0 = (1.0 + cos) * 0.5;
        b1 = -(1.0 + cos);
        b2 = (1.0 + cos) * 0.5;
    } else if filter_type == 3 {
        b0 = alpha;
        b1 = 0.0;
        b2 = -alpha;
    }

    (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
}

fn apply_biquad_filter(state: &mut FilterState, sample: f64, coefficients: (f64, f64, f64, f64, f64)) -> f64 {
    let (b0, b1, b2, a1, a2) = coefficients;
    let output = b0 * sample + b1 * state.x1 + b2 * state.x2 - a1 * state.y1 - a2 * state.y2;
    state.x2 = state.x1;
    state.x1 = sanitize_sample(sample, 4.0);
    state.y2 = state.y1;
    state.y1 = sanitize_sample(output, 4.0);
    state.y1
}

fn formant_band(morph: f64, intensity: f64, band_index: usize, sample_rate: f64) -> (f64, f64, f64) {
    let position = morph.clamp(0.0, 1.0) * ((FORMANT_VOWELS.len() - 1) as f64);
    let left_index = position.floor() as usize;
    let right_index = (left_index + 1).min(FORMANT_VOWELS.len() - 1);
    let t = position - left_index as f64;
    let strength = ((intensity - 0.1) / 11.9).clamp(0.0, 1.0);
    let overdrive = ((intensity - 12.0) / (FORMANT_INTENSITY_MAX - 12.0)).clamp(0.0, 1.0);
    let left = FORMANT_VOWELS[left_index][band_index];
    let right = FORMANT_VOWELS[right_index][band_index];
    let frequency = (left.frequency * (right.frequency / left.frequency).powf(t))
        .clamp(20.0, sample_rate * 0.45);
    let q = (left.q + (right.q - left.q) * t) * (0.7 + strength * 1.9 + overdrive * 4.2);
    let gain_db = left.gain_db + (right.gain_db - left.gain_db) * t + strength * 4.0 + overdrive * 18.0;
    (frequency, q.clamp(0.1, 96.0), 10.0_f64.powf(gain_db / 20.0))
}

fn apply_formant_filter(
    link_index: usize,
    link: Link,
    voice_slot: usize,
    sample_rate: f64,
    sample: f64,
) -> f64 {
    let intensity = link.filter_resonance.clamp(0.1, FORMANT_INTENSITY_MAX);
    let strength = ((intensity - 0.1) / 11.9).clamp(0.0, 1.0);
    let overdrive = ((intensity - 12.0) / (FORMANT_INTENSITY_MAX - 12.0)).clamp(0.0, 1.0);
    let mut wet = 0.0;

    unsafe {
        for band_index in 0..MAX_FORMANT_BANDS {
            let (frequency, q, gain) =
                formant_band(link.filter_cutoff, intensity, band_index, sample_rate);
            let coefficients = filter_coefficients(3, frequency, q, sample_rate);
            wet += apply_biquad_filter(
                &mut LINK_FORMANT_FILTERS[voice_slot][link_index][band_index],
                sample,
                coefficients,
            ) * gain;
        }
    }

    let dry_mix = 0.42 - strength * 0.18 - overdrive * 0.16;
    let wet_mix = 0.46 + strength * 0.38 + overdrive * 0.95;
    sanitize_sample(sample * dry_mix + wet * wet_mix, 4.0)
}

fn apply_link_filter(
    link_index: usize,
    link: Link,
    voice_slot: usize,
    sample_rate: f64,
    sample: f64,
) -> f64 {
    if link.filter_type == 0 {
        return sample;
    }
    if link.filter_type == 4 {
        return apply_formant_filter(link_index, link, voice_slot, sample_rate, sample);
    }

    let coefficients = filter_coefficients(
        link.filter_type,
        link.filter_cutoff,
        link.filter_resonance,
        sample_rate,
    );
    unsafe {
        apply_biquad_filter(&mut LINK_FILTERS[voice_slot][link_index], sample, coefficients)
    }
}

fn delay_slot_for_link(link_index: usize) -> Option<usize> {
    unsafe {
        if link_index >= MAX_LINKS {
            return None;
        }
        let existing = LINK_DELAY_SLOTS[link_index];
        if existing >= 0 {
            return Some(existing as usize);
        }
        if LINK_DELAY_SLOT_COUNT >= MAX_DELAY_SLOTS {
            return None;
        }
        let slot = LINK_DELAY_SLOT_COUNT;
        LINK_DELAY_SLOT_COUNT += 1;
        LINK_DELAY_SLOTS[link_index] = slot as i32;
        Some(slot)
    }
}

fn read_delay(buffer: &[f32; MAX_DELAY_SAMPLES], write_index: usize, delay_samples: f64) -> f64 {
    let length = MAX_DELAY_SAMPLES as f64;
    let mut index = write_index as f64 - delay_samples;
    while index < 0.0 {
        index += length;
    }
    let index_floor = index.floor();
    let index_a = index_floor as usize % MAX_DELAY_SAMPLES;
    let index_b = (index_a + 1) % MAX_DELAY_SAMPLES;
    let fraction = index - index_floor;
    buffer[index_a] as f64 * (1.0 - fraction) + buffer[index_b] as f64 * fraction
}

fn apply_link_delay(
    link_index: usize,
    link: Link,
    voice_slot: usize,
    sample_rate: f64,
    sample: f64,
) -> f64 {
    let clean_sample = sanitize_sample(sample, 4.0);
    if link.delay <= 0.0 {
        return clean_sample;
    }

    let Some(slot) = delay_slot_for_link(link_index) else {
        return clean_sample;
    };
    let max_delay_samples = (MAX_DELAY_SAMPLES - 1) as f64;
    let delay_samples = (link.delay * sample_rate).clamp(1.0, max_delay_samples);

    unsafe {
        if !LINK_DELAY_READY[voice_slot][slot] {
            LINK_DELAY_BUFFERS[voice_slot][slot].fill(clean_sample as f32);
            LINK_DELAY_INDICES[voice_slot][slot] = 0;
            LINK_DELAY_READY[voice_slot][slot] = true;
        }
        let write_index = LINK_DELAY_INDICES[voice_slot][slot];
        let delayed = read_delay(
            &LINK_DELAY_BUFFERS[voice_slot][slot],
            write_index,
            delay_samples,
        );
        LINK_DELAY_BUFFERS[voice_slot][slot][write_index] = clean_sample as f32;
        LINK_DELAY_INDICES[voice_slot][slot] = (write_index + 1) % MAX_DELAY_SAMPLES;
        sanitize_sample(delayed, 4.0)
    }
}

fn apply_signal_mode(
    link_index: usize,
    link: Link,
    voice_slot: usize,
    sample_rate: f64,
    sample: f64,
) -> f64 {
    if link.signal_mode == 0 {
        return sample;
    }

    unsafe {
        let input = sample.abs().clamp(0.0, 1.0);
        let current = LINK_FOLLOWERS[voice_slot][link_index];
        let time = if input > current {
            link.follower_attack
        } else {
            link.follower_release
        };
        let alpha = 1.0 - (-1.0 / (sample_rate * time.max(0.001))).exp();
        let next = (current + (input - current) * alpha).clamp(0.0, 1.0);
        LINK_FOLLOWERS[voice_slot][link_index] = next;
        if link.signal_mode == 2 {
            1.0 - next
        } else {
            next
        }
    }
}

struct LinkSignal {
    signal: f64,
    amount: f64,
    pan: f64,
    value: f64,
}

fn effective_link_params(
    link_index: usize,
    voice_slot: usize,
    sample_rate: f64,
    note_frequency: f64,
    velocity: f64,
    age: f64,
    release_age: f64,
    frame: usize,
    stamp: u32,
) -> Link {
    unsafe {
        if link_index >= LINK_COUNT {
            return EMPTY_LINK;
        }

        let base = LINKS[link_index];
        if LINK_PARAM_STACK[link_index] {
            return base;
        }

        LINK_PARAM_STACK[link_index] = true;

        let mut amplitude_mod = 0.0;
        let mut delay_mod = 0.0;
        let mut noise_mod = 0.0;
        let mut pan_mod = 0.0;
        let mut cutoff_mod = 0.0;
        let mut resonance_mod = 0.0;
        let mut env_delay_mod = 0.0;
        let mut env_attack_mod = 0.0;
        let mut env_decay_mod = 0.0;
        let mut env_sustain_mod = 0.0;
        let mut env_release_mod = 0.0;

        let mut mod_cursor = LINK_FIRST_MODULATOR[link_index];
        while mod_cursor >= 0 {
            let mod_index = mod_cursor as usize;
            let mod_link = LINKS[mod_index];
            mod_cursor = LINK_NEXT_MODULATOR[mod_index];
            if mod_link.from < 0 {
                continue;
            }

            let source = render_node(
                mod_link.from as usize,
                voice_slot,
                sample_rate,
                note_frequency,
                velocity,
                age,
                release_age,
                frame,
                stamp,
            );
            let modulation = render_link_signal(
                mod_index,
                source,
                voice_slot,
                sample_rate,
                note_frequency,
                velocity,
                age,
                release_age,
                frame,
                stamp,
                mod_link.target == TARGET_ENVELOPE_TRIGGER,
            );

            match mod_link.target {
                TARGET_AMPLITUDE => amplitude_mod += modulation.value,
                TARGET_DELAY => delay_mod += modulation.value,
                TARGET_NOISE => noise_mod += modulation.value,
                TARGET_PAN => pan_mod += modulation.value,
                TARGET_FILTER_CUTOFF => cutoff_mod += modulation.value,
                TARGET_FILTER_RESONANCE => resonance_mod += modulation.value,
                TARGET_ENVELOPE_DELAY => env_delay_mod += modulation.value,
                TARGET_ENVELOPE_ATTACK => env_attack_mod += modulation.value,
                TARGET_ENVELOPE_DECAY => env_decay_mod += modulation.value,
                TARGET_ENVELOPE_SUSTAIN => env_sustain_mod += modulation.value,
                TARGET_ENVELOPE_RELEASE => env_release_mod += modulation.value,
                TARGET_ENVELOPE_TRIGGER => {
                    apply_envelope_trigger(
                        link_index,
                        mod_index,
                        voice_slot,
                        age,
                        modulation.value,
                    );
                }
                _ => cutoff_mod += modulation.value,
            }
        }

        let mut effective = base;
        effective.amount = (base.amount * (1.0 + amplitude_mod).clamp(0.0, 4.0)).clamp(0.0, 32.0);
        effective.delay = (base.delay + delay_mod).clamp(0.0, 3.0);
        effective.noise = (base.noise + noise_mod).clamp(0.0, 1.0);
        effective.pan = (base.pan + pan_mod).clamp(-1.0, 1.0);
        effective.filter_cutoff = if base.filter_type == 4 {
            (base.filter_cutoff + cutoff_mod).clamp(0.0, 1.0)
        } else {
            (base.filter_cutoff * 2.0_f64.powf(cutoff_mod.clamp(-5.0, 5.0)))
                .clamp(20.0, sample_rate * 0.45)
        };
        effective.filter_resonance = (base.filter_resonance + resonance_mod).clamp(
            0.1,
            if base.filter_type == 4 { FORMANT_INTENSITY_MAX } else { 12.0 },
        );
        effective.env_delay = (base.env_delay + env_delay_mod).clamp(0.0, 4.0);
        effective.env_attack = (base.env_attack + env_attack_mod).clamp(0.001, 4.0);
        effective.env_decay = (base.env_decay + env_decay_mod).clamp(0.001, 4.0);
        effective.env_sustain = (base.env_sustain + env_sustain_mod).clamp(0.0, 1.0);
        effective.env_release = (base.env_release + env_release_mod).clamp(0.001, 6.0);

        LINK_PARAM_STACK[link_index] = false;
        effective
    }
}

#[allow(clippy::too_many_arguments)]
fn render_link_signal(
    link_index: usize,
    source: f64,
    voice_slot: usize,
    sample_rate: f64,
    note_frequency: f64,
    velocity: f64,
    age: f64,
    release_age: f64,
    frame: usize,
    stamp: u32,
    ignore_envelope: bool,
) -> LinkSignal {
    let link = effective_link_params(
        link_index,
        voice_slot,
        sample_rate,
        note_frequency,
        velocity,
        age,
        release_age,
        frame,
        stamp,
    );
    let filtered_source = apply_link_filter(link_index, link, voice_slot, sample_rate, source);
    let signal_source =
        apply_signal_mode(link_index, link, voice_slot, sample_rate, filtered_source);
    let noisy_source = apply_link_noise(signal_source, link, voice_slot);
    let envelope = if ignore_envelope {
        1.0
    } else {
        triggered_envelope_value(link_index, link, voice_slot, age, release_age)
    };
    let delayed_source = apply_link_delay(
        link_index,
        link,
        voice_slot,
        sample_rate,
        noisy_source * envelope * velocity_scale(link.velocity_sensitivity, velocity),
    );
    observe_link_meter(link_index, source, delayed_source * link.amount, envelope);
    LinkSignal {
        signal: delayed_source,
        amount: link.amount,
        pan: link.pan,
        value: delayed_source * link.amount,
    }
}

fn render_node(
    node_index: usize,
    voice_slot: usize,
    sample_rate: f64,
    note_frequency: f64,
    velocity: f64,
    age: f64,
    release_age: f64,
    frame: usize,
    stamp: u32,
) -> f64 {
    unsafe {
        if node_index >= NODE_COUNT {
            return 0.0;
        }
        if CACHE_STAMPS[node_index] == stamp {
            return RENDER_CACHE[node_index];
        }
        if RENDER_STACK[node_index] {
            return FEEDBACK[voice_slot][node_index];
        }

        RENDER_STACK[node_index] = true;
        let node = NODES[node_index];
        let mut phase_mod = 0.0;
        let mut frequency_mod = 0.0;
        let mut wave_mod = 0.0;
        let mut fold_drive = 0.0;
        let mut mix_amount = 0.0;
        let mut mix_signal = 0.0;
        let mut ring_amount = 0.0;
        let mut ring_signal = 0.0;

        for link_index in 0..LINK_COUNT {
            let link = LINKS[link_index];
            if link.to != node_index as i32 {
                continue;
            }
            let source = if link.from == node_index as i32 {
                FEEDBACK[voice_slot][node_index]
            } else if link.from >= 0 {
                render_node(
                    link.from as usize,
                    voice_slot,
                    sample_rate,
                    note_frequency,
                    velocity,
                    age,
                    release_age,
                    frame,
                    stamp,
                )
            } else {
                0.0
            };
            let modulation = render_link_signal(
                link_index,
                source,
                voice_slot,
                sample_rate,
                note_frequency,
                velocity,
                age,
                release_age,
                frame,
                stamp,
                link.target == TARGET_PHASE_RESET_TRIGGER,
            );
            match link.target {
                TARGET_FREQUENCY => frequency_mod += modulation.value,
                TARGET_WAVE => wave_mod += modulation.value,
                TARGET_PHASE_RESET_TRIGGER => {
                    apply_phase_reset_trigger(
                        node_index,
                        link_index,
                        voice_slot,
                        modulation.value,
                    );
                }
                TARGET_RING => {
                    ring_amount += modulation.amount;
                    ring_signal += modulation.signal * modulation.amount;
                }
                TARGET_FOLD => fold_drive += modulation.value.abs(),
                TARGET_MIX => {
                    mix_amount += modulation.amount.max(0.0);
                    mix_signal += modulation.signal * modulation.amount.max(0.0);
                }
                _ => phase_mod += modulation.value,
            }
        }

        let phase = PHASES[voice_slot][node_index];
        let node_base_frequency = base_frequency(node, note_frequency);
        let active_wave =
            node.wave == 6 || node.wave == 8 || node_base_frequency > 0.0;
        let wave = modulated_wave(node.wave, wave_mod);
        let custom_done = node.wave == 9 && custom_mode_is_finite(node.custom_mode) && CUSTOM_WAVE_DONE[voice_slot][node_index];
        let mut value = if active_wave && !custom_done {
            oscillator(node_index, node, phase + phase_mod, voice_slot, frame, wave)
        } else {
            0.0
        };
        value *= custom_one_shot_edge_gain(node, phase, node_base_frequency);

        if ring_amount > 0.0 {
            let depth = ring_amount.clamp(0.0, 1.0);
            value = sanitize_sample(
                value * (1.0 - depth) + value * (ring_signal / ring_amount) * depth,
                4.0,
            );
        }
        if fold_drive > 0.0 {
            value = sanitize_sample(
                fold_sample(value, 1.0 + fold_drive.clamp(0.0, 8.0) * 3.0),
                4.0,
            );
        }
        if mix_amount > 0.0 {
            let mix = mix_amount.clamp(0.0, 1.0);
            let carrier_gain = if mix <= 0.5 {
                1.0
            } else {
                1.0 - (mix - 0.5) * 2.0
            };
            let modulator_gain = if mix >= 0.5 { 1.0 } else { mix * 2.0 };
            value = sanitize_sample(
                value * carrier_gain + (mix_signal / mix_amount) * modulator_gain,
                4.0,
            );
        }

        value = sanitize_sample(value, 4.0);
        FREQUENCY_MODS[node_index] = frequency_mod;
        RENDER_CACHE[node_index] = value;
        CACHE_STAMPS[node_index] = stamp;
        FEEDBACK[voice_slot][node_index] = value;
        RENDER_STACK[node_index] = false;
        value
    }
}

fn finish_custom_phase(voice_slot: usize, node_index: usize, mut direction: f64, value: f64) {
    unsafe {
        if value >= 1.0 {
            CUSTOM_WAVE_DONE[voice_slot][node_index] = true;
            PHASES[voice_slot][node_index] = 1.0;
        } else {
            PHASES[voice_slot][node_index] = value.clamp(0.0, 1.0);
        }
        if direction == 0.0 {
            direction = 1.0;
        }
        CUSTOM_WAVE_DIRECTIONS[voice_slot][node_index] = direction;
    }
}

fn advance_custom_wave_phase(
    voice_slot: usize,
    node_index: usize,
    node: Node,
    step: f64,
    release_age: f64,
) {
    unsafe {
        let released = release_age >= 0.0;
        let current = PHASES[voice_slot][node_index];
        let mut direction = CUSTOM_WAVE_DIRECTIONS[voice_slot][node_index];
        if direction == 0.0 {
            direction = 1.0;
        }
        let start = node.custom_sustain_start.clamp(0.0, 0.999);
        let end = node.custom_sustain_end.clamp(start + 0.001, 1.0);
        let length = (end - start).max(0.001);

        match node.custom_mode {
            CUSTOM_MODE_PING_PONG => {
                let mut next = current + step * direction;
                if next >= 1.0 {
                    next = 1.0 - (next - 1.0);
                    direction = -1.0;
                } else if next <= 0.0 {
                    next = -next;
                    direction = 1.0;
                }
                finish_custom_phase(voice_slot, node_index, direction, next);
            }
            CUSTOM_MODE_ONCE => {
                finish_custom_phase(voice_slot, node_index, direction, current + step);
            }
            CUSTOM_MODE_SUSTAIN => {
                let mut next = current + step;
                if !released && next >= start {
                    next = start;
                }
                finish_custom_phase(voice_slot, node_index, direction, next);
            }
            CUSTOM_MODE_SUSTAIN_LOOP => {
                let mut next = current + step;
                if !released && next >= start {
                    next = start + (((next - start) % length) + length) % length;
                }
                finish_custom_phase(voice_slot, node_index, direction, next);
            }
            CUSTOM_MODE_SUSTAIN_PING_PONG => {
                let mut next = current + step * direction;
                if !released {
                    if next >= end {
                        next = end - (next - end);
                        direction = -1.0;
                    } else if next <= start && current >= start {
                        next = start + (start - next);
                        direction = 1.0;
                    } else if next >= start && current < start {
                        direction = 1.0;
                    }
                    finish_custom_phase(voice_slot, node_index, direction, next);
                } else {
                    if direction < 0.0 && next <= start {
                        next = start + (start - next);
                        direction = 1.0;
                    }
                    finish_custom_phase(voice_slot, node_index, direction, next);
                }
            }
            _ => {
                PHASES[voice_slot][node_index] = normalize_phase(current + step);
                CUSTOM_WAVE_DIRECTIONS[voice_slot][node_index] = direction;
            }
        }
    }
}

fn advance_phases(voice_slot: usize, sample_rate: f64, note_frequency: f64, release_age: f64) {
    unsafe {
        for node_index in 0..NODE_COUNT {
            let node = NODES[node_index];
            if node.wave == 6 || node.wave == 8 {
                FREQUENCY_MODS[node_index] = 0.0;
                continue;
            }
            let frequency_mod = if node.wave == 7 {
                0.0
            } else {
                FREQUENCY_MODS[node_index].clamp(-5.0, 5.0)
            };
            let multiplier = 2.0_f64.powf(frequency_mod);
            let frequency = if node.wave == 7 {
                node.speed
            } else {
                base_frequency(node, note_frequency)
            };
            let step = (frequency * multiplier) / sample_rate;
            if node.wave == 9 {
                advance_custom_wave_phase(voice_slot, node_index, node, step, release_age);
                FREQUENCY_MODS[node_index] = 0.0;
                continue;
            }
            let next_phase = PHASES[voice_slot][node_index] + step;
            if node.wave == 5 && next_phase >= 1.0 {
                SAMPLE_HOLDS[voice_slot][node_index] = random_bipolar(voice_slot);
                SAMPLE_HOLD_SET[voice_slot][node_index] = true;
            }
            if node.wave == 7 && next_phase >= 1.0 {
                if !PERLIN_SET[voice_slot][node_index] {
                    PERLIN_CURRENT[voice_slot][node_index] = random_bipolar(voice_slot);
                    PERLIN_NEXT[voice_slot][node_index] = random_bipolar(voice_slot);
                    PERLIN_SET[voice_slot][node_index] = true;
                }
                PERLIN_CURRENT[voice_slot][node_index] = PERLIN_NEXT[voice_slot][node_index];
                PERLIN_NEXT[voice_slot][node_index] = random_bipolar(voice_slot);
            }
            PHASES[voice_slot][node_index] = normalize_phase(next_phase);
            FREQUENCY_MODS[node_index] = 0.0;
        }
    }
}

#[no_mangle]
pub extern "C" fn renderVoiceGraph(
    slot: u32,
    frames: u32,
    sample_rate: f64,
    note_frequency: f64,
    velocity: f64,
    lifecycle_gain: f64,
    voice_age: f64,
    release_age: f64,
) {
    let frames = (frames as usize).min(MAX_WASM_FRAMES);
    if frames == 0 || sample_rate <= 0.0 {
        return;
    }

    let voice_slot = (slot as usize).min(MAX_VOICE_SLOTS - 1);
    let left = core::ptr::addr_of_mut!(LEFT).cast::<f32>();
    let right = core::ptr::addr_of_mut!(RIGHT).cast::<f32>();
    let amp = velocity.clamp(0.0, 1.0) * lifecycle_gain.clamp(0.0, 1.0);

    for frame in 0..frames {
        let stamp = next_stamp();
        let mut left_sample = 0.0;
        let mut right_sample = 0.0;
        let sample_offset = frame as f64 / sample_rate;
        let age = voice_age + sample_offset;
        let sample_release_age = if release_age < 0.0 {
            -1.0
        } else {
            release_age + sample_offset
        };

        unsafe {
            for link_index in 0..LINK_COUNT {
                let link = LINKS[link_index];
                if link.to != AUDIO_TARGET || link.from < 0 {
                    continue;
                }
                let source = render_node(
                    link.from as usize,
                    voice_slot,
                    sample_rate,
                    note_frequency,
                    velocity,
                    age,
                    sample_release_age,
                    frame,
                    stamp,
                );
                let modulation = render_link_signal(
                    link_index,
                    source,
                    voice_slot,
                    sample_rate,
                    note_frequency,
                    velocity,
                    age,
                    sample_release_age,
                    frame,
                    stamp,
                    false,
                );
                let signal = modulation.value * amp;
                let (left_gain, right_gain) = pan_gains(modulation.pan);
                left_sample = sanitize_sample(left_sample + signal * left_gain, 8.0);
                right_sample = sanitize_sample(right_sample + signal * right_gain, 8.0);
            }

            *left.add(frame) += left_sample as f32;
            *right.add(frame) += right_sample as f32;
        }

        advance_phases(voice_slot, sample_rate, note_frequency, sample_release_age);
    }
}
