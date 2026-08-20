/**
 * Making the buzzers audible.
 *
 * The pitch and the loudness are measured in the worker off the actual drive waveform, so what
 * comes out of the speakers is what the circuit is doing rather than a sound effect played when a
 * flag goes true. Change the resistor feeding a buzzer and it gets quieter; drive a passive one at
 * a different rate and the note changes, because the note *is* the rate.
 *
 * Deliberately quiet. A 2 kHz square wave at any real volume is unpleasant, and a simulator that
 * makes people reach for the mute button every time they press Run has not helped them.
 *
 * Browsers refuse to start audio until the page has been interacted with, which is why the context
 * is created lazily and resumed rather than started: by the time a buzzer sounds, someone has
 * pressed Run, and that counts.
 */
import { useEffect, useRef } from 'react';
import type { SoundingPart } from './protocol.ts';

/**
 * Peak gain, at the loudest a part can claim.
 *
 * A square wave is all odd harmonics and sounds far louder than its amplitude suggests, so this is
 * low on purpose.
 */
const MAX_GAIN = 0.045;

/** Below this a part is not worth opening an oscillator for. */
const MIN_DB = 35;

/** Ramp time for changes, seconds. Long enough to avoid a click, short enough to sound immediate. */
const RAMP = 0.015;

interface Voice {
  readonly oscillator: OscillatorNode;
  readonly gain: GainNode;
}

/** Decibels to a gain, referenced so that a typical 85 dB buzzer sits near the top of the range. */
function gainFor(db: number): number {
  if (db < MIN_DB) return 0;
  // 20 dB quieter is a tenth of the amplitude, which is what a decibel means.
  return Math.min(MAX_GAIN, MAX_GAIN * 10 ** ((db - 90) / 20));
}

export function useBuzzerAudio(sounds: readonly SoundingPart[], enabled: boolean): void {
  const contextRef = useRef<AudioContext | null>(null);
  const voicesRef = useRef(new Map<string, Voice>());

  // Silence everything on the way out, or a stopped simulation keeps humming.
  useEffect(() => {
    const voices = voicesRef.current;
    return () => {
      for (const voice of voices.values()) voice.oscillator.stop();
      voices.clear();
      void contextRef.current?.close();
      contextRef.current = null;
    };
  }, []);

  useEffect(() => {
    const voices = voicesRef.current;

    const silence = () => {
      for (const [id, voice] of voices) {
        voice.oscillator.stop();
        voices.delete(id);
      }
    };

    if (!enabled || sounds.length === 0) {
      silence();
      return;
    }

    if (!contextRef.current) {
      contextRef.current = new AudioContext();
    }
    const context = contextRef.current;
    if (context.state === 'suspended') void context.resume();

    const now = context.currentTime;
    const wanted = new Set<string>();

    for (const sound of sounds) {
      const gain = gainFor(sound.db);
      if (gain <= 0) continue;
      wanted.add(sound.partId);

      let voice = voices.get(sound.partId);
      if (!voice) {
        const oscillator = context.createOscillator();
        // Square, because that is what a buzzer is. A sine would be kinder and would not sound
        // like the part.
        oscillator.type = 'square';
        const gainNode = context.createGain();
        gainNode.gain.value = 0;
        oscillator.connect(gainNode).connect(context.destination);
        oscillator.start();
        voice = { oscillator, gain: gainNode };
        voices.set(sound.partId, voice);
      }

      voice.oscillator.frequency.setTargetAtTime(sound.hz, now, RAMP);
      voice.gain.gain.setTargetAtTime(gain, now, RAMP);
    }

    for (const [id, voice] of voices) {
      if (wanted.has(id)) continue;
      voice.oscillator.stop();
      voices.delete(id);
    }
  }, [sounds, enabled]);
}
