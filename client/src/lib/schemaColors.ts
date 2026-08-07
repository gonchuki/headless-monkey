/**
 * Deterministic per-schema color identity.
 *
 * Same name → same colors, always. Pure arithmetic on the name string;
 * no randomness, no runtime state.
 */

/** Hash a string with FNV-1a (32-bit). */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // force unsigned 32-bit
  }
  return hash;
}

/** Colors returned for a schema name. */
export interface SchemaColors {
  background: string;
  foreground: string;
}

/**
 * Derive a deterministic color pair from a schema name.
 *
 * Uses FNV-1a → hue, then picks a contrasting foreground based on
 * the computed background luminance.
 */
export function schemaColor(name: string): SchemaColors {
  const hash = fnv1a(name);

  // Spread hues using golden-angle rotation so adjacent names rarely collide visually.
  const hue = (hash % 360 + 137.508) % 360;
  const saturation = 65;
  const lightness = 45;

  const bg = `hsl(${hue}, ${saturation}%, ${lightness}%)`;

  // Convert HSL to RGB for luminance calculation.
  const h = hue / 360;
  const s = saturation / 100;
  const l = lightness / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s; // chroma
  const x = c * (1 - Math.abs((h * 6) % 2 - 1));
  const m = l - c / 2;

  let r = 0, g = 0, b = 0;
  const sector = Math.floor(h * 6);
  switch (sector) {
    case 0: r = c; g = x; break;
    case 1: r = x; g = c; break;
    case 2: g = c; b = x; break;
    case 3: g = x; b = c; break;
    case 4: r = x; b = c; break;
    case 5: r = c; b = x; break;
  }

  // Relative luminance (sRGB).
  const relLum =
    0.2126 * srgbLinear(r + m) +
    0.7152 * srgbLinear(g + m) +
    0.0722 * srgbLinear(b + m);

  // Dark foreground for light backgrounds, light foreground for dark backgrounds.
  const fg = relLum > 0.179 ? "rgb(255, 255, 255)" : "rgb(25, 25, 25)";

  return { background: bg, foreground: fg };
}

function srgbLinear(v: number): number {
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
