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
