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
  for (const l of listeners) l(muted);
}

export function toggleMuted(): void {
  setMuted(!muted);
}

export function subscribeMuted(listener: (muted: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tone(freq: number, startOffsetS: number, durationS: number, peakGain: number, type: OscillatorType = "sine") {
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
  gain.connect(audio.destination);
  osc.start(start);
  osc.stop(start + durationS + 0.02);
}

function noiseBurst(durationS: number, peakGain: number, filterFreq: number) {
  const audio = getCtx();
  if (!audio) return;
  const sampleCount = Math.max(1, Math.floor(audio.sampleRate * durationS));
  const buffer = audio.createBuffer(1, sampleCount, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;

  const source = audio.createBufferSource();
  source.buffer = buffer;
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = filterFreq;
  const gain = audio.createGain();
  const start = audio.currentTime;
  gain.gain.setValueAtTime(peakGain, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationS);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(audio.destination);
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
  tone(240, 0, 0.14, 0.07, "sawtooth");
  tone(190, 0.16, 0.16, 0.07, "sawtooth");
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
  humGain.connect(audio.destination);
  humSource.start();

  // Close-up engine buzz: a detuned pair of low sawtooth oscillators.
  const engineGain = audio.createGain();
  engineGain.gain.value = 0;
  const engineFilter = audio.createBiquadFilter();
  engineFilter.type = "lowpass";
  engineFilter.frequency.value = 480;
  engineFilter.connect(engineGain);
  engineGain.connect(audio.destination);
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
  rumbleGain.connect(audio.destination);
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

function applyFxLevels(): void {
  const audio = getCtx();
  if (!fx || !audio) return;
  const now = audio.currentTime;
  fx.rainGain.gain.cancelScheduledValues(now);
  fx.sirenGain.gain.cancelScheduledValues(now);
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
  rainGain.connect(audio.destination);
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
  sirenGain.connect(audio.destination);
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
  tone(1040, 0, 0.07, 0.035, "square");
  tone(1040, 0.12, 0.07, 0.035, "square");
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
  roarGain.connect(audio.destination);
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
  jakeGain.connect(audio.destination);
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
  thumpGain.connect(audio.destination);
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
  roarLevel = 0;
  jakeLevel = 0;
  concreteRoad = false;
  if (road) applyRoadLevels();
}
