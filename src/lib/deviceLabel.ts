/**
 * Resolving an audio device by NAME, because nothing else about it is stable.
 *
 * Two separate instabilities bite here:
 *
 *  - Windows numbers a duplicated endpoint INSIDE the name, so the same headset
 *    comes back as "Headset Microphone (3- Astro A50 Voice)" after a replug, and
 *    Chromium appends a USB id on top: " (9886:002c)".
 *
 *  - Chromium's deviceId hashes are reassigned when that renumbering happens. A
 *    saved id does not merely go stale, it can come to mean a DIFFERENT physical
 *    microphone. That is exactly how the soundboard once captured an Insta360
 *    lapel mic while the A50 sat unused, held two capture streams open at once,
 *    and left Discord showing a permanent green ring.
 *
 * So the label, normalized, is the identifier we trust. A saved id is a hint.
 */
export function normalizeDeviceLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\b\d+-\s*/g, '')                            // "(3- Astro A50 Voice)" -> "(astro a50 voice)"
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*/gi, ' ')  // drop Chromium's " (9886:002c)"
    .replace(/\s+/g, ' ')
    .trim();
}

/** The device whose name matches `wantLabel`, or null. Exact match wins. */
export function findDeviceByLabel<T extends { deviceId: string; label: string }>(
  devices: T[],
  wantLabel: string | null | undefined,
): T | null {
  if (!wantLabel) return null;
  const want = normalizeDeviceLabel(wantLabel);
  if (!want) return null;

  const exact = devices.find((d) => normalizeDeviceLabel(d.label) === want);
  if (exact) return exact;

  return (
    devices.find((d) => {
      const have = normalizeDeviceLabel(d.label);
      return have.length > 0 && (have.includes(want) || want.includes(have));
    }) ?? null
  );
}
