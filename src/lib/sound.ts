"use client";

/**
 * Tiny synthesized sound effects via the Web Audio API — no audio files.
 * Everything is a plain oscillator/noise burst shaped with a gain envelope.
 */

const MUTE_KEY = "road-constructor:muted:v1";

let ctx: AudioContext | null = null;
let muted = loadMutePref();
const listeners = new Set<(muted: boolean) => void>();

function loadMutePref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// ---------------------------------------------------------------------------
// The mixer. Every sound goes through one of three group buses (effects: the interface chimes and thumps; ambience:
// traffic, engines, rain, road; alerts: sirens, crossing beeps, warning honks), then a master gain and a limiter, so
// layering many loops never clips and the player can balance the groups. Levels are remembered in this browser.
// ---------------------------------------------------------------------------

export type SoundGroup = "effects" | "ambience" | "alerts" | "radio";
export type MixLevels = Record<SoundGroup | "master", number>;

const MIX_KEY = "road-constructor:mix:v1";
const DEFAULT_MIX: MixLevels = { master: 1, effects: 1, ambience: 1, alerts: 1, radio: 0.8 };

function loadMix(): MixLevels {
  const mix = { ...DEFAULT_MIX };
  if (typeof window === "undefined") return mix;
  try {
    const raw = window.localStorage.getItem(MIX_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<MixLevels>;
      for (const k of Object.keys(mix) as (keyof MixLevels)[]) {
        const v = p[k];
        if (typeof v === "number" && Number.isFinite(v)) mix[k] = Math.min(1.5, Math.max(0, v));
      }
    }
  } catch {
    // unreadable: defaults
  }
  return mix;
}

let mix: MixLevels = loadMix();
const mixListeners = new Set<() => void>();

interface Mixer {
  master: GainNode;
  limiter: DynamicsCompressorNode;
  groups: Record<SoundGroup, GainNode>;
}
let mixer: Mixer | null = null;
/** How far the ambience is pushed down while an alert is sounding (1 = not at all), easing back after. */
let ambienceDuck = 1;
let duckTimer: ReturnType<typeof setTimeout> | null = null;

function getMixer(audio: AudioContext): Mixer {
  if (mixer) return mixer;
  const master = audio.createGain();
  // A limiter in front of the speakers: loud overlaps are squeezed instead of clipping.
  const limiter = audio.createDynamicsCompressor();
  limiter.threshold.value = -14;
  limiter.knee.value = 10;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.22;
  master.connect(limiter);
  limiter.connect(audio.destination);
  const groups = {} as Record<SoundGroup, GainNode>;
  for (const g of ["effects", "ambience", "alerts", "radio"] as SoundGroup[]) {
    groups[g] = audio.createGain();
    groups[g].connect(master);
  }
  mixer = { master, limiter, groups };
  applyMix();
  return mixer;
}

/** The bus a sound plays into. */
function bus(audio: AudioContext, group: SoundGroup): AudioNode {
  return getMixer(audio).groups[group];
}

function applyMix(): void {
  if (!mixer || !ctx) return;
  const now = ctx.currentTime;
  mixer.master.gain.setTargetAtTime(muted ? 0 : mix.master, now, 0.05);
  mixer.groups.effects.gain.setTargetAtTime(mix.effects, now, 0.05);
  mixer.groups.ambience.gain.setTargetAtTime(mix.ambience * ambienceDuck, now, 0.12);
  mixer.groups.alerts.gain.setTargetAtTime(mix.alerts, now, 0.05);
  mixer.groups.radio.gain.setTargetAtTime(mix.radio, now, 0.08);
}

export function getMixLevels(): MixLevels {
  return mix;
}

export function setMixLevel(key: keyof MixLevels, value: number): void {
  mix = { ...mix, [key]: Math.min(1.5, Math.max(0, value)) };
  try {
    window.localStorage.setItem(MIX_KEY, JSON.stringify(mix));
  } catch {
    // ignore
  }
  applyMix();
  mixListeners.forEach((l) => l());
}

export function resetMix(): void {
  mix = { ...DEFAULT_MIX };
  try {
    window.localStorage.removeItem(MIX_KEY);
  } catch {
    // ignore
  }
  applyMix();
  mixListeners.forEach((l) => l());
}

export function subscribeMix(listener: () => void): () => void {
  mixListeners.add(listener);
  return () => mixListeners.delete(listener);
}

/** Pushes the ambience down to `depth` of its level for `holdS` seconds (an alert is sounding), then eases it back. */
function duckAmbience(depth: number, holdS: number): void {
  ambienceDuck = depth;
  applyMix();
  if (duckTimer) clearTimeout(duckTimer);
  duckTimer = setTimeout(() => {
    ambienceDuck = wantSiren ? SIREN_DUCK : 1;
    applyMix();
  }, holdS * 1000);
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(MUTE_KEY, value ? "1" : "0");
    } catch {
      // ignore
    }
  }
  if (value && ambience) {
    ambience.humGain.gain.value = 0;
    ambience.engineGain.gain.value = 0;
    ambience.rumbleGain.gain.value = 0;
  }
  if (fx) applyFxLevels();
  if (road) applyRoadLevels();
  applyMix();
  for (const l of listeners) l(muted);
}

export function toggleMuted(): void {
  setMuted(!muted);
}

export function subscribeMuted(listener: (muted: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tone(freq: number, startOffsetS: number, durationS: number, peakGain: number, type: OscillatorType = "sine", group: SoundGroup = "effects") {
  const audio = getCtx();
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const start = audio.currentTime + startOffsetS;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peakGain, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationS);
  osc.connect(gain);
  gain.connect(bus(audio, group));
  osc.start(start);
  osc.stop(start + durationS + 0.02);
}

function noiseBurst(durationS: number, peakGain: number, filterFreq: number, group: SoundGroup = "effects", filterType: BiquadFilterType = "lowpass") {
  const audio = getCtx();
  if (!audio) return;
  const sampleCount = Math.max(1, Math.floor(audio.sampleRate * durationS));
  const buffer = audio.createBuffer(1, sampleCount, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;

  const source = audio.createBufferSource();
  source.buffer = buffer;
  const filter = audio.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = filterFreq;
  const gain = audio.createGain();
  const start = audio.currentTime;
  gain.gain.setValueAtTime(peakGain, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationS);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(bus(audio, group));
  source.start(start);
  source.stop(start + durationS + 0.02);
}

/** A short upward blip when a road segment is placed. */
export function playPlaceRoad(): void {
  if (muted) return;
  tone(720, 0, 0.09, 0.09, "triangle");
  tone(980, 0.03, 0.08, 0.06, "triangle");
}

/** A low thud when a road or junction is demolished. */
export function playDemolish(): void {
  if (muted) return;
  noiseBurst(0.18, 0.28, 320);
  tone(90, 0, 0.16, 0.12, "sine");
}

/** A cheerful ascending arpeggio when a destination contract is newly met. */
export function playSuccessChime(): void {
  if (muted) return;
  tone(523.25, 0, 0.16, 0.08, "sine");
  tone(659.25, 0.09, 0.16, 0.08, "sine");
  tone(783.99, 0.18, 0.22, 0.09, "sine");
}

/** A fuller, longer fanfare for finishing a whole campaign scenario. */
export function playVictoryFanfare(): void {
  if (muted) return;
  tone(523.25, 0, 0.18, 0.09, "triangle");
  tone(659.25, 0.1, 0.18, 0.09, "triangle");
  tone(783.99, 0.2, 0.18, 0.09, "triangle");
  tone(1046.5, 0.32, 0.4, 0.11, "triangle");
  tone(1318.5, 0.34, 0.38, 0.07, "sine");
}

/** A short, low descending "womp" when a scenario run ends without a win. */
export function playFailTone(): void {
  if (muted) return;
  tone(220, 0, 0.22, 0.09, "sawtooth");
  tone(164.81, 0.14, 0.3, 0.08, "sawtooth");
}

/** A brief filtered-noise whoosh while dragging out a new road segment. */
export function playDrawWhoosh(): void {
  if (muted) return;
  noiseBurst(0.1, 0.05, 2200);
}

/** A low, brief double-honk when a road segment breaks down to Level of Service F. */
export function playGridlockHonk(): void {
  if (muted) return;
  tone(240, 0, 0.14, 0.07, "sawtooth", "alerts");
  tone(190, 0.16, 0.16, 0.07, "sawtooth", "alerts");
}

/** A quick double clack-clack when a vehicle rolls over a bridge expansion joint. `volume` (0-1) is how near the listener is. */
export function playExpansionJointClack(volume = 1): void {
  if (muted || volume <= 0.01) return;
  noiseBurst(0.035, 0.05 * volume, 3200);
  tone(140, 0.05, 0.03, 0.03 * volume, "square");
  noiseBurst(0.035, 0.045 * volume, 3000);
  tone(130, 0.14, 0.03, 0.025 * volume, "square");
}

// ---------------------------------------------------------------------------
// Persistent ambience: a distant-highway hum (zoomed out) that crossfades
// into a closer engine buzz (zoomed in), driven by camera zoom every frame.
// Lazily created on first use and never recreated, so gain/frequency changes
// are just parameter automation rather than restarting audio graphs.
// ---------------------------------------------------------------------------

interface AmbienceGraph {
  humGain: GainNode;
  engineGain: GainNode;
  /** The detuned oscillator pair driving the close-up engine buzz — kept around so their pitch can track average traffic speed. */
  engineOscillators: OscillatorNode[];
  /** A fixed low rumble standing in for the truck fraction of the fleet, faded in only while traffic is actually moving. */
  rumbleGain: GainNode;
}

let ambience: AmbienceGraph | null = null;

function ensureAmbience(): AmbienceGraph | null {
  const audio = getCtx();
  if (!audio) return null;
  if (ambience) return ambience;

  // Distant highway hum: filtered looping noise, low and steady.
  const humSampleCount = audio.sampleRate * 2;
  const humBuffer = audio.createBuffer(1, humSampleCount, audio.sampleRate);
  const humData = humBuffer.getChannelData(0);
  for (let i = 0; i < humSampleCount; i++) humData[i] = Math.random() * 2 - 1;
  const humSource = audio.createBufferSource();
  humSource.buffer = humBuffer;
  humSource.loop = true;
  const humFilter = audio.createBiquadFilter();
  humFilter.type = "lowpass";
  humFilter.frequency.value = 220;
  const humGain = audio.createGain();
  humGain.gain.value = 0;
  humSource.connect(humFilter);
  humFilter.connect(humGain);
  humGain.connect(bus(audio, "ambience"));
  humSource.start();

  // Close-up engine buzz: a detuned pair of low sawtooth oscillators.
  const engineGain = audio.createGain();
  engineGain.gain.value = 0;
  const engineFilter = audio.createBiquadFilter();
  engineFilter.type = "lowpass";
  engineFilter.frequency.value = 480;
  engineFilter.connect(engineGain);
  engineGain.connect(bus(audio, "ambience"));
  const engineOscillators: OscillatorNode[] = [];
  for (const detune of [-6, 6]) {
    const osc = audio.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 55;
    osc.detune.value = detune;
    osc.connect(engineFilter);
    osc.start();
    engineOscillators.push(osc);
  }

  // Truck rumble: a low, steady sawtooth standing in for the ~15% of the
  // fleet simulated as heavy trucks — fades in only while traffic is
  // actually moving, since we don't plumb per-vehicle class to the main
  // thread and average speed is already a reasonable proxy for "there's a
  // live network to hear."
  const rumbleGain = audio.createGain();
  rumbleGain.gain.value = 0;
  const rumbleFilter = audio.createBiquadFilter();
  rumbleFilter.type = "lowpass";
  rumbleFilter.frequency.value = 150;
  rumbleFilter.connect(rumbleGain);
  rumbleGain.connect(bus(audio, "ambience"));
  const rumbleOsc = audio.createOscillator();
  rumbleOsc.type = "sawtooth";
  rumbleOsc.frequency.value = 38;
  rumbleOsc.connect(rumbleFilter);
  rumbleOsc.start();

  ambience = { humGain, engineGain, engineOscillators, rumbleGain };
  return ambience;
}

/**
 * Crossfades the ambient bed based on camera zoom: `zoomFactor` should be
 * ~0 fully zoomed out (highway hum dominant) to ~1 fully zoomed in (engine
 * buzz dominant). Safe to call every frame — it only nudges gain values.
 */
export function updateAmbience(zoomFactor: number): void {
  if (muted) {
    if (ambience) {
      ambience.humGain.gain.value = 0;
      ambience.engineGain.gain.value = 0;
      ambience.rumbleGain.gain.value = 0;
    }
    return;
  }
  const graph = ensureAmbience();
  if (!graph) return;
  const t = Math.min(1, Math.max(0, zoomFactor));
  const audio = getCtx();
  const now = audio?.currentTime ?? 0;
  graph.humGain.gain.linearRampToValueAtTime(0.05 * (1 - t), now + 0.3);
  graph.engineGain.gain.linearRampToValueAtTime(0.035 * t, now + 0.3);
}

const ENGINE_IDLE_FREQ = 55;
const ENGINE_CRUISE_FREQ = 92;
/** Average speed (mph) at which the engine pitch reaches its cruise ceiling. */
const ENGINE_PITCH_REFERENCE_MPH = 55;

/**
 * Ties the close-up engine buzz's pitch and the truck-rumble layer's level
 * to live traffic conditions: `avgSpeedMph` is the sim's current
 * network-wide average speed (0 when the network is empty or paused).
 * Safe to call every frame — it only nudges existing oscillator/gain
 * parameters, never rebuilds the audio graph.
 */
export function updateEngineDynamics(avgSpeedMph: number): void {
  if (muted) return;
  const graph = ensureAmbience();
  if (!graph) return;
  const audio = getCtx();
  const now = audio?.currentTime ?? 0;
  const speedT = Math.min(1, Math.max(0, avgSpeedMph / ENGINE_PITCH_REFERENCE_MPH));
  const freq = ENGINE_IDLE_FREQ + speedT * (ENGINE_CRUISE_FREQ - ENGINE_IDLE_FREQ);
  for (const osc of graph.engineOscillators) {
    osc.frequency.linearRampToValueAtTime(freq, now + 0.4);
  }
  const trafficMoving = avgSpeedMph > 0.5 ? 1 : 0;
  graph.rumbleGain.gain.linearRampToValueAtTime(trafficMoving * 0.02, now + 0.6);
}

// ---------------------------------------------------------------------------
// Weather and emergency layers: steady rain, and an ambulance siren. Created the first time they are needed and
// then only nudged, like the ambience above. Both go silent while muted.
// ---------------------------------------------------------------------------

interface FxGraph {
  rainGain: GainNode;
  sirenGain: GainNode;
}
let fx: FxGraph | null = null;
let wantRain = false;
let wantSiren = false;
const SIREN_DUCK = 0.65;

function applyFxLevels(): void {
  const audio = getCtx();
  if (!fx || !audio) return;
  const now = audio.currentTime;
  fx.rainGain.gain.cancelScheduledValues(now);
  fx.sirenGain.gain.cancelScheduledValues(now);
  // An ambulance wailing pushes the rest of the soundscape down so it can be heard.
  ambienceDuck = wantSiren ? SIREN_DUCK : 1;
  applyMix();
  fx.rainGain.gain.linearRampToValueAtTime(!muted && wantRain ? 0.05 : 0, now + 0.8);
  fx.sirenGain.gain.linearRampToValueAtTime(!muted && wantSiren ? 0.03 : 0, now + 0.15);
}

function ensureFx(): FxGraph | null {
  const audio = getCtx();
  if (!audio) return null;
  if (fx) return fx;

  // Rain: looping noise, band-limited so it hisses rather than rumbles.
  const len = audio.sampleRate * 2;
  const buf = audio.createBuffer(1, len, audio.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const rainSrc = audio.createBufferSource();
  rainSrc.buffer = buf;
  rainSrc.loop = true;
  const rainFilter = audio.createBiquadFilter();
  rainFilter.type = "bandpass";
  rainFilter.frequency.value = 2600;
  rainFilter.Q.value = 0.5;
  const rainGain = audio.createGain();
  rainGain.gain.value = 0;
  rainSrc.connect(rainFilter);
  rainFilter.connect(rainGain);
  rainGain.connect(bus(audio, "ambience"));
  rainSrc.start();

  // Siren: a tone whose pitch swings up and down, driven by a slow oscillator.
  const sirenOsc = audio.createOscillator();
  sirenOsc.type = "triangle";
  sirenOsc.frequency.value = 820;
  const lfo = audio.createOscillator();
  lfo.frequency.value = 0.9;
  const lfoDepth = audio.createGain();
  lfoDepth.gain.value = 190;
  lfo.connect(lfoDepth);
  lfoDepth.connect(sirenOsc.frequency);
  const sirenGain = audio.createGain();
  sirenGain.gain.value = 0;
  sirenOsc.connect(sirenGain);
  sirenGain.connect(bus(audio, "alerts"));
  sirenOsc.start();
  lfo.start();

  fx = { rainGain, sirenGain };
  return fx;
}

/** Turns the rain sound on or off with the weather. */
export function setRainSound(on: boolean): void {
  wantRain = on;
  if (!on && !fx) return;
  if (!ensureFx()) return;
  applyFxLevels();
}

/** Turns the siren on while an ambulance is on the road. */
export function setSirenSound(on: boolean): void {
  wantSiren = on;
  if (!on && !fx) return;
  if (!ensureFx()) return;
  applyFxLevels();
}

/** A soft double beep for a pedestrian crossing signal. */
export function playCrossingBeep(): void {
  if (muted) return;
  tone(1040, 0, 0.07, 0.06, "square", "alerts");
  tone(1040, 0.12, 0.07, 0.06, "square", "alerts");
}

// ---------------------------------------------------------------------------
// Road texture: the roar of tyres near the listener (a hiss that gets louder and brighter on wet asphalt) and the
// stuttering rumble of a truck's engine brake on a downgrade. Both are fed a 0-1 level from what is near the camera.
// ---------------------------------------------------------------------------

interface RoadGraph {
  roarGain: GainNode;
  roarFilter: BiquadFilterNode;
  jakeGain: GainNode;
  /** Level of the slab-joint thumps, and the two sawtooths (one per axle) that clock them. */
  thumpGain: GainNode;
  thumpClocks: OscillatorNode[];
}
let road: RoadGraph | null = null;
let roarLevel = 0;
let roarWet = false;
let jakeLevel = 0;
let concreteRoad = false;
let concreteMph = 0;

function ensureRoad(): RoadGraph | null {
  const audio = getCtx();
  if (!audio) return null;
  if (road) return road;

  const len = audio.sampleRate * 2;
  const buf = audio.createBuffer(1, len, audio.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = audio.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const roarFilter = audio.createBiquadFilter();
  roarFilter.type = "bandpass";
  roarFilter.frequency.value = 700;
  roarFilter.Q.value = 0.7;
  const roarGain = audio.createGain();
  roarGain.gain.value = 0;
  src.connect(roarFilter);
  roarFilter.connect(roarGain);
  roarGain.connect(bus(audio, "ambience"));
  src.start();

  // Engine brake: a low sawtooth chopped by a fast tremolo, which is what makes it a "brrrrap" and not a hum.
  const jakeOsc = audio.createOscillator();
  jakeOsc.type = "sawtooth";
  jakeOsc.frequency.value = 74;
  const jakeFilter = audio.createBiquadFilter();
  jakeFilter.type = "lowpass";
  jakeFilter.frequency.value = 380;
  const chop = audio.createGain();
  chop.gain.value = 0.5;
  const lfo = audio.createOscillator();
  lfo.type = "square";
  lfo.frequency.value = 23;
  const lfoDepth = audio.createGain();
  lfoDepth.gain.value = 0.5;
  lfo.connect(lfoDepth);
  lfoDepth.connect(chop.gain);
  const jakeGain = audio.createGain();
  jakeGain.gain.value = 0;
  jakeOsc.connect(jakeFilter);
  jakeFilter.connect(chop);
  chop.connect(jakeGain);
  jakeGain.connect(bus(audio, "ambience"));
  jakeOsc.start();
  lfo.start();

  // Concrete slab joints: low, rounded noise that a pair of sawtooth clocks (front and rear axle, a beat apart) gate
  // into short thumps through a waveshaper, so each joint goes "ba-dum". The clock rate follows speed over slab length.
  const thumpSrc = audio.createBufferSource();
  thumpSrc.buffer = buf;
  thumpSrc.loop = true;
  const thumpFilter = audio.createBiquadFilter();
  thumpFilter.type = "lowpass";
  thumpFilter.frequency.value = 170;
  const thumpGain = audio.createGain();
  thumpGain.gain.value = 0;
  const gate = audio.createGain();
  gate.gain.value = 0;
  const curve = new Float32Array(256);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = x > 0.55 ? ((x - 0.55) / 0.45) ** 2 : 0;
  }
  const thumpClocks: OscillatorNode[] = [];
  for (const lag of [0, 0.045]) {
    const clock = audio.createOscillator();
    clock.type = "sawtooth";
    clock.frequency.value = 4.5;
    const shaper = audio.createWaveShaper();
    shaper.curve = curve;
    const axle = audio.createGain();
    axle.gain.value = lag === 0 ? 1 : 0.7;
    clock.connect(shaper);
    shaper.connect(axle);
    axle.connect(gate.gain);
    clock.start(audio.currentTime + lag);
    thumpClocks.push(clock);
  }
  thumpSrc.connect(thumpFilter);
  thumpFilter.connect(gate);
  gate.connect(thumpGain);
  thumpGain.connect(bus(audio, "ambience"));
  thumpSrc.start();

  road = { roarGain, roarFilter, jakeGain, thumpGain, thumpClocks };
  return road;
}

function applyRoadLevels(): void {
  const audio = getCtx();
  if (!road || !audio) return;
  const now = audio.currentTime;
  // Transverse-tined concrete sings higher and louder than asphalt, and its joints thump in time with the speed.
  const roar = muted ? 0 : roarLevel * (roarWet ? 0.055 : concreteRoad ? 0.032 : 0.02);
  road.roarGain.gain.linearRampToValueAtTime(roar, now + 0.25);
  road.roarFilter.frequency.linearRampToValueAtTime(roarWet ? 1900 : concreteRoad ? 1150 : 750, now + 0.6);
  road.thumpGain.gain.linearRampToValueAtTime(muted || !concreteRoad ? 0 : roarLevel * 0.2, now + 0.25);
  const jointsPerS = Math.min(9, Math.max(1.2, (concreteMph * 1.4667) / CONCRETE_SLAB_FT));
  for (const clock of road.thumpClocks) clock.frequency.linearRampToValueAtTime(jointsPerS, now + 0.4);
  road.jakeGain.gain.linearRampToValueAtTime(muted ? 0 : jakeLevel * 0.045, now + 0.2);
}

/** Tyre roar near the listener: `level` 0-1 from how many vehicles are close, `wet` for rain-slick asphalt. */
export function setRoadRoar(level: number, wet: boolean): void {
  roarLevel = Math.min(1, Math.max(0, level));
  roarWet = wet;
  if (roarLevel === 0 && !road) return;
  if (!ensureRoad()) return;
  applyRoadLevels();
}

/** A transverse-joint spacing typical of Texas concrete freeways. */
const CONCRETE_SLAB_FT = 17;

/** Switches on the TxDOT concrete sound (the ba-dum of slab joints, and a higher tyre whine) at roughly `mph` of traffic speed. */
export function setConcreteRoad(on: boolean, mph: number): void {
  concreteRoad = on;
  concreteMph = mph;
  if (!on && !road) return;
  if (!ensureRoad()) return;
  applyRoadLevels();
}

/** The engine brake of a heavy truck slowing on a grade, `level` 0-1 by how near the loudest one is. */
export function setJakeBrake(level: number): void {
  jakeLevel = Math.min(1, Math.max(0, level));
  if (jakeLevel === 0 && !road) return;
  if (!ensureRoad()) return;
  applyRoadLevels();
}

/** Silences every road layer (leaving the game page). */
export function stopRoadSounds(): void {
  honkLevel = 0;
  roarLevel = 0;
  jakeLevel = 0;
  concreteRoad = false;
  if (road) applyRoadLevels();
  setPlayerEngine(false);
  setRadioStation("off");
}

// ---------------------------------------------------------------------------
// Alarms and arcade cues: the siren that opens a warning banner, a chime for a flow combo, and the muffled horns of
// drivers who are stuck (a chorus whose busyness follows how many are fuming near the listener).
// ---------------------------------------------------------------------------

/** Two rising and falling whoops, for a warning banner. */
export function playAlertSiren(): void {
  if (muted) return;
  const audio = getCtx();
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sawtooth";
  const now = audio.currentTime;
  for (let i = 0; i < 2; i++) {
    osc.frequency.setValueAtTime(520, now + i * 0.9);
    osc.frequency.linearRampToValueAtTime(980, now + i * 0.9 + 0.45);
    osc.frequency.linearRampToValueAtTime(520, now + i * 0.9 + 0.9);
  }
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.05, now + 0.05);
  gain.gain.setValueAtTime(0.05, now + 1.65);
  gain.gain.linearRampToValueAtTime(0, now + 1.85);
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2200;
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(bus(audio, "alerts"));
  osc.start(now);
  osc.stop(now + 1.9);
  duckAmbience(0.55, 2.2);
}

/** A bright rising arpeggio that climbs a little higher with each combo in a row. */
export function playComboChime(combo: number): void {
  if (muted) return;
  const lift = Math.min(6, Math.max(0, combo - 1));
  const base = 660 * 2 ** (lift / 12);
  tone(base, 0, 0.18, 0.07, "triangle");
  tone(base * 1.26, 0.08, 0.18, 0.07, "triangle");
  tone(base * 1.5, 0.16, 0.18, 0.07, "triangle");
  tone(base * 2, 0.24, 0.35, 0.08, "triangle");
}

let honkLevel = 0;
let honkTimer: ReturnType<typeof setTimeout> | null = null;

function honkOnce(level: number): void {
  const audio = getCtx();
  if (!audio || muted) return;
  // A couple of horns, a little out of tune with each other, low-passed so it sounds like it is coming from the next block.
  const root = 330 + Math.random() * 120;
  const dur = 0.18 + Math.random() * 0.4;
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 650;
  const gain = audio.createGain();
  const now = audio.currentTime;
  const peak = 0.045 * level;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.02);
  gain.gain.setValueAtTime(peak, now + dur);
  gain.gain.linearRampToValueAtTime(0, now + dur + 0.05);
  for (const ratio of [1, 1.26]) {
    const osc = audio.createOscillator();
    osc.type = "square";
    osc.frequency.value = root * ratio * (1 + (Math.random() - 0.5) * 0.02);
    osc.connect(filter);
    osc.start(now);
    osc.stop(now + dur + 0.08);
  }
  filter.connect(gain);
  gain.connect(bus(audio, "ambience"));
}

function scheduleHonk(): void {
  if (honkLevel <= 0.03) {
    honkTimer = null;
    return;
  }
  honkOnce(honkLevel);
  // The more drivers fuming nearby, the more often somebody leans on the horn.
  honkTimer = setTimeout(scheduleHonk, 260 + (1 - honkLevel) * 1700 + Math.random() * 500);
}

/** `level` 0-1: how many angry drivers are near the listener. 0 silences the chorus. */
export function setHonkChorus(level: number): void {
  honkLevel = Math.min(1, Math.max(0, level));
  if (honkLevel > 0.03 && honkTimer === null && !muted) honkTimer = setTimeout(scheduleHonk, 150);
}

// ---------------------------------------------------------------------------
// Driving: the player's own engine (it changes gear as the speed climbs, so the pitch climbs and drops), tyre squeal on
// a hard stop and the indicator's tick while a lane change is waiting for a gap.
// ---------------------------------------------------------------------------

interface PlayerEngine {
  oscillators: OscillatorNode[];
  filter: BiquadFilterNode;
  gain: GainNode;
  intakeGain: GainNode;
}
let playerEngine: PlayerEngine | null = null;

function ensurePlayerEngine(): PlayerEngine | null {
  const audio = getCtx();
  if (!audio) return null;
  if (playerEngine) return playerEngine;
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 500;
  const gain = audio.createGain();
  gain.gain.value = 0;
  filter.connect(gain);
  gain.connect(bus(audio, "ambience"));
  const oscillators: OscillatorNode[] = [];
  // two sawtooths a few cents apart for the body, and a square an octave down for the growl
  for (const [type, detune, octave] of [["sawtooth", -7, 1], ["sawtooth", 7, 1], ["square", 0, 0.5]] as [OscillatorType, number, number][]) {
    const osc = audio.createOscillator();
    osc.type = type;
    osc.frequency.value = 40 * octave;
    osc.detune.value = detune;
    const level = audio.createGain();
    level.gain.value = octave === 1 ? 0.5 : 0.28;
    osc.connect(level);
    level.connect(filter);
    osc.start();
    oscillators.push(osc);
  }
  // intake hiss under load
  const len = audio.sampleRate;
  const buf = audio.createBuffer(1, len, audio.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = audio.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const bp = audio.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1400;
  bp.Q.value = 0.6;
  const intakeGain = audio.createGain();
  intakeGain.gain.value = 0;
  src.connect(bp);
  bp.connect(intakeGain);
  intakeGain.connect(bus(audio, "ambience"));
  src.start();
  playerEngine = { oscillators, filter, gain, intakeGain };
  return playerEngine;
}

/** Top speed (mph) of each gear: the engine note climbs through a gear's range and drops when the next one is engaged. */
const GEAR_TOP_MPH = [13, 25, 38, 52, 68, 140];

/** Engine revs for a speed: 0.28 (just engaged) to 1 (top of the gear). Pure, for tests. */
export function engineRevs(mph: number): { gear: number; revs: number } {
  let gear = GEAR_TOP_MPH.findIndex((top) => mph < top);
  if (gear < 0) gear = GEAR_TOP_MPH.length - 1;
  const low = gear === 0 ? 0 : GEAR_TOP_MPH[gear - 1] * 0.62;
  const t = Math.min(1, Math.max(0, (mph - low) / (GEAR_TOP_MPH[gear] - low)));
  return { gear: gear + 1, revs: 0.28 + 0.72 * t };
}

/** Measured with the level probe: the engine came out 5 dB louder than everything else, so it is brought down. */
const PLAYER_ENGINE_TRIM = 0.56;

/** How each kind of vehicle sounds from the driver's seat: the pitch of its engine, how loud and how muffled it is, and how much wind there is (a bicycle has no engine at all). */
const ENGINE_VOICES: Record<string, { pitch: number; level: number; muffle: number; wind: number }> = {
  car: { pitch: 1, level: 1, muffle: 1, wind: 1 },
  truck: { pitch: 0.62, level: 1.35, muffle: 0.7, wind: 1.1 },
  bus: { pitch: 0.58, level: 1.3, muffle: 0.65, wind: 1.1 },
  bike: { pitch: 1, level: 0, muffle: 1, wind: 2.2 },
  ambulance: { pitch: 0.9, level: 1.15, muffle: 1.1, wind: 1 },
  police: { pitch: 1.05, level: 1.1, muffle: 1.1, wind: 1 },
  wrecker: { pitch: 0.7, level: 1.25, muffle: 0.75, wind: 1 },
};

/** The player's engine: on while driving, at `mph`, with `throttle` -1 (braking) to 1, in the voice of `kind`. Call every frame; `on: false` fades it out. */
export function setPlayerEngine(on: boolean, mph = 0, throttle = 0, kind = "car"): void {
  if (!on && !playerEngine) return;
  const e = ensurePlayerEngine();
  const audio = getCtx();
  if (!e || !audio) return;
  const now = audio.currentTime;
  if (!on || muted) {
    e.gain.gain.linearRampToValueAtTime(0, now + 0.25);
    e.intakeGain.gain.linearRampToValueAtTime(0, now + 0.25);
    return;
  }
  const voice = ENGINE_VOICES[kind] ?? ENGINE_VOICES.car;
  const { revs } = engineRevs(mph);
  const load = Math.max(0, throttle);
  const freq = (36 + revs * 88) * voice.pitch;
  for (const osc of e.oscillators) osc.frequency.linearRampToValueAtTime(freq * (osc.type === "square" ? 0.5 : 1), now + 0.06);
  e.filter.frequency.linearRampToValueAtTime((380 + revs * 420 + load * 900) * voice.muffle, now + 0.1);
  e.gain.gain.linearRampToValueAtTime((0.035 + revs * 0.02 + load * 0.035) * voice.level * PLAYER_ENGINE_TRIM, now + 0.1);
  // wind and tyre hiss grow with speed on top of the engine's own intake (all there is on a bicycle)
  e.intakeGain.gain.linearRampToValueAtTime((load * 0.02 * revs * voice.level + Math.min(1, mph / 60) * 0.014 * voice.wind) * PLAYER_ENGINE_TRIM, now + 0.1);
}

/** Tyres squealing on a hard stop. */
export function playBrakeSqueal(): void {
  if (muted) return;
  noiseBurst(0.45, 0.1, 2600, "alerts", "bandpass");
}

/** The indicator's tick, while a lane change waits for a gap. */
export function playIndicatorTick(): void {
  if (muted) return;
  tone(1650, 0, 0.018, 0.03, "square", "alerts");
}

// ---------------------------------------------------------------------------
// Sound check: plays one of the game's sounds on demand, so the mix can be balanced by ear in the settings.
// ---------------------------------------------------------------------------

export const SOUND_CHECKS: { id: string; label: string; group: SoundGroup }[] = [
  { id: "place", label: "Place a road", group: "effects" },
  { id: "demolish", label: "Demolish", group: "effects" },
  { id: "chime", label: "Goal met", group: "effects" },
  { id: "fanfare", label: "Level won", group: "effects" },
  { id: "combo", label: "Flow combo", group: "effects" },
  { id: "traffic", label: "Traffic and engines", group: "ambience" },
  { id: "rain", label: "Rain on the road", group: "ambience" },
  { id: "concrete", label: "Concrete slabs", group: "ambience" },
  { id: "horns", label: "Horns", group: "ambience" },
  { id: "drive", label: "Your engine", group: "ambience" },
  { id: "radio-lofi", label: "Radio: lo-fi", group: "radio" },
  { id: "radio-synth", label: "Radio: synthwave", group: "radio" },
  { id: "radio-dispatch", label: "Radio: dispatch", group: "radio" },
  { id: "siren", label: "Alert siren", group: "alerts" },
  { id: "ambulance", label: "Ambulance", group: "alerts" },
  { id: "crossing", label: "Crossing beeps", group: "alerts" },
  { id: "squeal", label: "Hard stop", group: "alerts" },
];

/** Plays a sound check; looping layers run for a few seconds and then stop. Returns how long it runs (ms). */
export function playSoundCheck(id: string): number {
  const stopAfter = (ms: number, stop: () => void) => {
    setTimeout(stop, ms);
    return ms;
  };
  switch (id) {
    case "place":
      playPlaceRoad();
      return 400;
    case "demolish":
      playDemolish();
      return 500;
    case "chime":
      playSuccessChime();
      return 600;
    case "fanfare":
      playVictoryFanfare();
      return 900;
    case "combo":
      playComboChime(3);
      return 700;
    case "traffic": {
      updateAmbience(0.9);
      updateEngineDynamics(45);
      setRoadRoar(0.9, false);
      return stopAfter(3200, () => {
        updateAmbience(0);
        updateEngineDynamics(0);
        setRoadRoar(0, false);
      });
    }
    case "rain":
      setRainSound(true);
      setRoadRoar(0.9, true);
      return stopAfter(3200, () => {
        setRainSound(false);
        setRoadRoar(0, false);
      });
    case "concrete":
      setConcreteRoad(true, 60);
      setRoadRoar(0.9, false);
      return stopAfter(3200, () => {
        setConcreteRoad(false, 0);
        setRoadRoar(0, false);
      });
    case "horns":
      setHonkChorus(0.9);
      return stopAfter(3400, () => setHonkChorus(0));
    case "drive": {
      let mph = 0;
      const timer = setInterval(() => {
        mph = Math.min(70, mph + 2.6);
        setPlayerEngine(true, mph, 1);
      }, 100);
      return stopAfter(3000, () => {
        clearInterval(timer);
        setPlayerEngine(false);
      });
    }
    case "radio-lofi":
    case "radio-synth":
    case "radio-dispatch": {
      const was = station;
      setRadioStation(id === "radio-lofi" ? "lofi" : id === "radio-synth" ? "synth" : "dispatch");
      return stopAfter(4500, () => setRadioStation(was));
    }
    case "siren":
      playAlertSiren();
      return 2000;
    case "ambulance":
      setSirenSound(true);
      return stopAfter(2800, () => setSirenSound(false));
    case "crossing":
      playCrossingBeep();
      return 400;
    case "squeal":
      playBrakeSqueal();
      return 600;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// The car radio: three generated stations that play while you drive. Nothing is recorded; each is a few oscillators and
// some noise on a clock, scheduled a little ahead of the audio time.
// ---------------------------------------------------------------------------

export type RadioStation = "off" | "lofi" | "synth" | "dispatch";
export const RADIO_STATIONS: { id: RadioStation; label: string; emoji: string }[] = [
  { id: "off", label: "Radio off", emoji: "📻" },
  { id: "lofi", label: "Lo-fi", emoji: "☕" },
  { id: "synth", label: "Synthwave", emoji: "🌆" },
  { id: "dispatch", label: "Dispatch", emoji: "📡" },
];

let station: RadioStation = "off";
let radioTimer: ReturnType<typeof setInterval> | null = null;
let radioBeat = 0;
let radioNextAt = 0;
let radioNoise: AudioBuffer | null = null;
/** Per-station loudness trims from the level probe: lo-fi was 3 dB hot and the dispatch chatter 4 dB quiet against the rest. */
const RADIO_TRIM: Record<RadioStation, number> = { off: 1, lofi: 0.7, synth: 1, dispatch: 1.6 };

function noiseBuffer(audio: AudioContext): AudioBuffer {
  if (radioNoise) return radioNoise;
  const buf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  radioNoise = buf;
  return buf;
}

/** One note into the radio bus. */
function radioNote(audio: AudioContext, at: number, freq: number, dur: number, peak: number, type: OscillatorType, cutoff = 2400, attack = 0.02) {
  const osc = audio.createOscillator();
  const filter = audio.createBiquadFilter();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak * RADIO_TRIM[station], at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(bus(audio, "radio"));
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/** A burst of noise (a hat, a snare, a breath of static). */
function radioNoiseHit(audio: AudioContext, at: number, dur: number, peak: number, freq: number, type: BiquadFilterType = "highpass") {
  const src = audio.createBufferSource();
  src.buffer = noiseBuffer(audio);
  const filter = audio.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(peak * RADIO_TRIM[station], at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(bus(audio, "radio"));
  src.start(at, Math.random() * 0.5);
  src.stop(at + dur + 0.02);
}

const LOFI_CHORDS = [
  [261.63, 329.63, 392, 493.88],
  [220, 261.63, 329.63, 392],
  [293.66, 349.23, 440, 523.25],
  [196, 246.94, 293.66, 349.23],
];

/** Pure: the notes of a chord of the lo-fi loop, so tests can check the progression repeats every four chords. */
export function lofiChord(index: number): number[] {
  return LOFI_CHORDS[((index % LOFI_CHORDS.length) + LOFI_CHORDS.length) % LOFI_CHORDS.length];
}

const SYNTH_BASS = [55, 55, 65.41, 49, 55, 55, 73.42, 65.41];
const SYNTH_ARP = [220, 261.63, 329.63, 392, 440, 392, 329.63, 261.63];

function scheduleRadio(): void {
  const audio = getCtx();
  if (!audio || muted || station === "off") return;
  // keep about half a second of music scheduled ahead
  while (radioNextAt < audio.currentTime + 0.5) {
    const t = Math.max(radioNextAt, audio.currentTime + 0.02);
    if (station === "lofi") {
      // 72 bpm: a chord every 4 beats (3.33 s), hats on the off-beats, a crackle now and then
      const beat = 60 / 72;
      const step = radioBeat % 8; // eighth notes, 8 per chord
      const chord = lofiChord(Math.floor(radioBeat / 8));
      if (step === 0) {
        chord.forEach((f, i) => radioNote(audio, t + i * 0.035, f, 3.2, 0.05, "sine", 1500, 0.12));
        radioNote(audio, t, chord[0] / 2, 3.0, 0.09, "sine", 400, 0.05);
      }
      if (step % 2 === 1) radioNoiseHit(audio, t, 0.05, 0.07, 6500);
      if (step === 0 || step === 5) radioNoiseHit(audio, t, 0.12, 0.09, 220, "lowpass");
      if (Math.random() < 0.18) radioNoiseHit(audio, t + Math.random() * beat, 0.012, 0.05, 3000);
      radioBeat++;
      radioNextAt = t + beat / 2;
    } else if (station === "synth") {
      const beat = 60 / 108;
      const step = radioBeat % 8;
      radioNote(audio, t, SYNTH_BASS[step], beat / 2 * 0.95, 0.09, "sawtooth", 520, 0.005);
      radioNote(audio, t, SYNTH_ARP[(step * 3 + Math.floor(radioBeat / 16)) % 8] * (step % 4 === 3 ? 2 : 1), beat / 2 * 0.8, 0.035, "square", 2600, 0.004);
      if (step % 4 === 0) {
        // a kick: a sine that drops
        const osc = audio.createOscillator();
        const g = audio.createGain();
        osc.frequency.setValueAtTime(130, t);
        osc.frequency.exponentialRampToValueAtTime(45, t + 0.14);
        g.gain.setValueAtTime(0.16, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        osc.connect(g);
        g.connect(bus(audio, "radio"));
        osc.start(t);
        osc.stop(t + 0.22);
      }
      if (step % 4 === 2) radioNoiseHit(audio, t, 0.14, 0.1, 1800);
      radioBeat++;
      radioNextAt = t + beat / 2;
    } else {
      // dispatch: static bed, and now and then a short call: a few syllables of band-limited noise, then the roger beep
      radioNoiseHit(audio, t, 0.5, 0.012, 1800, "bandpass");
      if (radioBeat % 14 === 0) {
        const syllables = 3 + Math.floor(Math.random() * 6);
        let at = t + 0.1;
        radioNote(audio, at - 0.05, 1500, 0.06, 0.03, "square", 4000, 0.003); // click on
        for (let i = 0; i < syllables; i++) {
          const dur = 0.07 + Math.random() * 0.12;
          radioNoiseHit(audio, at, dur, 0.1, 500 + Math.random() * 900, "bandpass");
          radioNote(audio, at, 110 + Math.random() * 70, dur, 0.03, "sawtooth", 900, 0.01);
          at += dur + 0.03 + Math.random() * 0.1;
        }
        radioNote(audio, at + 0.05, 1400, 0.08, 0.04, "sine", 5000, 0.003);
        radioNote(audio, at + 0.16, 1000, 0.1, 0.04, "sine", 5000, 0.003);
      }
      radioBeat++;
      radioNextAt = t + 0.5;
    }
  }
}

/** Tunes the car radio (it plays while you drive). "off" silences it. */
export function setRadioStation(next: RadioStation): void {
  station = next;
  radioBeat = 0;
  if (radioTimer) {
    clearInterval(radioTimer);
    radioTimer = null;
  }
  if (next === "off") return;
  const audio = getCtx();
  if (!audio) return;
  getMixer(audio);
  radioNextAt = audio.currentTime + 0.05;
  radioTimer = setInterval(scheduleRadio, 120);
  scheduleRadio();
}

export function getRadioStation(): RadioStation {
  return station;
}

// ---------------------------------------------------------------------------
// Level probe: measures how loud each sound really is (from the mixer's output), so the mix can be balanced by numbers
// where nobody is there to listen. Used by the sound check in development and by tests in a browser.
// ---------------------------------------------------------------------------

export interface LevelReading {
  /** Loudest sample, dB relative to full scale. */
  peakDb: number;
  /** Root-mean-square over the stretch the sound was audible, dBFS. */
  rmsDb: number;
  /** Seconds the output stayed above silence. */
  audibleS: number;
  /** The audio clock was running (a browser keeps it suspended until the page has been touched). */
  contextRunning: boolean;
}

/** Plays a sound check and reads the mixer output while it runs. */
export async function measureSoundCheck(id: string): Promise<LevelReading> {
  const audio = getCtx();
  if (!audio) return { peakDb: -Infinity, rmsDb: -Infinity, audibleS: 0, contextRunning: false };
  const m = getMixer(audio);
  const analyser = audio.createAnalyser();
  analyser.fftSize = 2048;
  m.limiter.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let peak = 0;
  let sumSq = 0;
  let n = 0;
  let audible = 0;
  const ms = playSoundCheck(id);
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let blockSq = 0;
      for (const x of data) {
        blockSq += x * x;
        if (Math.abs(x) > peak) peak = Math.abs(x);
      }
      const blockRms = Math.sqrt(blockSq / data.length);
      if (blockRms > 0.0005) {
        sumSq += blockSq;
        n += data.length;
        audible += 0.05;
      }
      if (performance.now() - start < ms + 250) setTimeout(tick, 50);
      else resolve();
    };
    tick();
  });
  m.limiter.disconnect(analyser);
  const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return { peakDb: db(peak), rmsDb: db(n > 0 ? Math.sqrt(sumSq / n) : 0), audibleS: audible, contextRunning: audio.state === "running" };
}

// Dev builds only: `await __soundLevels()` in the console prints every sound check's loudness.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __soundLevels: () => Promise<Record<string, LevelReading>> }).__soundLevels = async () => {
    const out: Record<string, LevelReading> = {};
    for (const c of SOUND_CHECKS) {
      out[c.id] = await measureSoundCheck(c.id);
      await new Promise((r) => setTimeout(r, 400));
    }
    return out;
  };
}
