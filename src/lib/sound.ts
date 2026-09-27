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
  }
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

// ---------------------------------------------------------------------------
// Persistent ambience: a distant-highway hum (zoomed out) that crossfades
// into a closer engine buzz (zoomed in), driven by camera zoom every frame.
// Lazily created on first use and never recreated, so gain/frequency changes
// are just parameter automation rather than restarting audio graphs.
// ---------------------------------------------------------------------------

interface AmbienceGraph {
  humGain: GainNode;
  engineGain: GainNode;
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
  for (const detune of [-6, 6]) {
    const osc = audio.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 55;
    osc.detune.value = detune;
    osc.connect(engineFilter);
    osc.start();
  }

  ambience = { humGain, engineGain };
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
