import type { NetworkSnapshot } from "../types";
import type { SceneryData } from "../osm/scenery";

/**
 * Real road networks baked from OpenStreetMap by scripts/osm/build.ts: real geometry, lane counts, speed limits,
 * bridge and tunnel heights, and traffic signals. Map data © OpenStreetMap contributors (ODbL).
 *
 * Each city is its own chunk, fetched when its level opens (`loadRealCity`) rather than shipped with the page.
 */
export interface RealCityData {
  meta: { key: string; name: string; bbox: [number, number, number, number]; attribution: string; generated: string };
  network: NetworkSnapshot;
  /** Real building footprints and water from OpenStreetMap, drawn around the roads. */
  scenery?: SceneryData;
}

const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  "los-angeles": () => import("./los-angeles.json"),
  "new-york": () => import("./new-york.json"),
  "toronto": () => import("./toronto.json"),
  "houston": () => import("./houston.json"),
  "san-antonio": () => import("./san-antonio.json"),
  "monterrey": () => import("./monterrey.json"),
  "dallas": () => import("./dallas.json"),
  "chicago": () => import("./chicago.json"),
  "atlanta": () => import("./atlanta.json"),
  "lincoln-tunnel": () => import("./lincoln-tunnel.json"),
  "monterrey-tec": () => import("./monterrey-tec.json"),
  "monterrey-valle-oriente": () => import("./monterrey-valle-oriente.json"),
  "monterrey-uanl": () => import("./monterrey-uanl.json"),
  "monterrey-hospital-universitario": () => import("./monterrey-hospital-universitario.json"),
  "monterrey-fundidora": () => import("./monterrey-fundidora.json"),
  "monterrey-estadio": () => import("./monterrey-estadio.json"),
  "monterrey-juan-pablo-ii": () => import("./monterrey-juan-pablo-ii.json"),
};

const loaded = new Map<string, RealCityData>();
const loading = new Map<string, Promise<RealCityData>>();

/** True once a city's data is in memory, so `getRealCity` can hand it over synchronously. */
export function isRealCityLoaded(key: string): boolean {
  return loaded.has(key);
}

/** Fetches a city's data (once; later calls reuse it). */
export function loadRealCity(key: string): Promise<RealCityData> {
  const have = loaded.get(key);
  if (have) return Promise.resolve(have);
  const pending = loading.get(key);
  if (pending) return pending;
  const loader = LOADERS[key];
  if (!loader) return Promise.reject(new Error(`no real city "${key}"`));
  const p = loader().then((m) => {
    const data = m.default as RealCityData;
    loaded.set(key, data);
    loading.delete(key);
    return data;
  });
  p.catch(() => loading.delete(key));
  loading.set(key, p);
  return p;
}

/** A city that has already been loaded; throws if `loadRealCity` hasn't finished for it. */
export function getRealCity(key: string): RealCityData {
  const d = loaded.get(key);
  if (!d) throw new Error(`real city "${key}" has not been loaded yet`);
  return d;
}

export const OSM_ATTRIBUTION = "Map data © OpenStreetMap contributors (ODbL)";
