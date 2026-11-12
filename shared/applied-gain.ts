// What a playing sound's output is REALLY set to, read back from the audio nodes themselves.
//
// Why this exists (2026-11-12). The Cortex popout and dock have a "You hear" slider that writes `monitorVolume`. Whether
// that changes what he hears could only be shown by recording his headphones, and he said no to that. So CarbonBoard says
// what it applied: for each playing sound, each of its two outputs (the cable, and the monitor in his own headphones)
// reports the gain its node holds right now. It is the program reporting its own state, not a measurement of sound: it
// cannot show that a device is plugged in, unmuted in Windows, or on his head.
//
// Three paths (store.tsx playSound / attachGain):
//   gain     the element runs through a GainNode on its own AudioContext, so it can pass 100%. The element's own volume
//            still multiplies in front of the node, so what reaches the device is node gain x element volume.
//   element  the context could not be put on that device: the element's own volume is all there is, capped at 100%.
//            A "You hear" above 100% does nothing on this path, which is the thing worth being able to see.
//   off      there is no element for this output at all (monitor set to "off"): the slider cannot change anything.
//
// Kept free of DOM types so it runs under plain node (shared/applied-gain.test.mjs).

export type AppliedPath = 'gain' | 'element' | 'off';

export interface AppliedGain {
  path: AppliedPath;
  /** The linear gain reaching the device for this sound (1 = 100%); null when there is no output or it cannot be read. */
  applied: number | null;
  /** False when nothing can be coming out: no output, a paused or muted element, or a context that is not running. */
  running: boolean;
}

interface ElementLike { volume: number; muted?: boolean; paused?: boolean }
interface GainLike { gain: { value: number }; context?: { state?: string } | null }

const round = (v: number): number => Math.round(v * 10_000) / 10_000;

export function appliedGain(element: ElementLike | null | undefined, node: GainLike | null | undefined): AppliedGain {
  if (!element) return { path: 'off', applied: null, running: false };
  const own = element.muted ? 0 : element.volume;
  if (!Number.isFinite(own)) return { path: node ? 'gain' : 'element', applied: null, running: false };
  const playing = !element.paused && !element.muted;
  if (!node) return { path: 'element', applied: round(own), running: playing };
  const g = node.gain.value;
  if (!Number.isFinite(g)) return { path: 'gain', applied: null, running: false };
  // A context that says nothing about its state (an older Chromium) is taken as running; one that says "suspended" or
  // "closed" is not, whatever the gain reads.
  const state = node.context?.state;
  return { path: 'gain', applied: round(g * own), running: playing && (state === undefined || state === 'running') };
}
