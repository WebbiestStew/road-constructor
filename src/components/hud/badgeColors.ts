/** Distinct badge colors cycled across named entries/destinations, shared between the in-world badges and the minimap so a location reads as the same color in both places. */
export const BADGE_PALETTE = [
  "#0d9488", // teal
  "#7c3aed", // violet
  "#92400e", // brown
  "#db2777", // magenta
  "#dc2626", // red
  "#16a34a", // green
  "#2563eb", // blue
  "#ea580c", // orange
];

export function badgeColorForIndex(index: number): string {
  return BADGE_PALETTE[index % BADGE_PALETTE.length];
}
