import type { NetworkSnapshot } from "../types";
import losAngeles from "./los-angeles.json";
import monterrey from "./monterrey.json";
import newYork from "./new-york.json";
import houston from "./houston.json";
import sanAntonio from "./san-antonio.json";
import toronto from "./toronto.json";

/**
 * Real road networks baked from OpenStreetMap by scripts/osm/build.ts: real geometry, lane counts, speed limits,
 * bridge and tunnel heights, and traffic signals. Map data © OpenStreetMap contributors (ODbL).
 */
export interface RealCityData {
  meta: { key: string; name: string; bbox: [number, number, number, number]; attribution: string; generated: string };
  network: NetworkSnapshot;
}

export const REAL_CITY_DATA = {
  "los-angeles": losAngeles,
  "new-york": newYork,
  toronto,
  houston,
  "san-antonio": sanAntonio,
  monterrey,
} as unknown as Record<string, RealCityData>;

export const OSM_ATTRIBUTION = "Map data © OpenStreetMap contributors (ODbL)";
