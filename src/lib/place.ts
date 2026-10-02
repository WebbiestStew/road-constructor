import { convertOsm, type OsmData } from "@/sim/osm/convert";
import { EMPTY_SCENERY, convertScenery, sceneryQuery, type SceneryData } from "@/sim/osm/scenery";
import type { NetworkSnapshot } from "@/sim/types";

/**
 * "Load any place": search a place name on OpenStreetMap's Nominatim, pull the roads around it from the Overpass
 * API, and convert them with the same code that bakes the built-in real-city levels. Everything runs in the
 * player's browser; the only thing sent anywhere is the search text and the map box, to those two public services.
 */

export interface PlaceHit {
  name: string;
  lat: number;
  lon: number;
}

const MIRRORS = ["https://lz4.overpass-api.de", "https://overpass-api.de", "https://z.overpass-api.de"];
/** A mirror that has not answered in this long is skipped for the next one. */
const ATTEMPT_TIMEOUT_MS = 25_000;
/** Half the side of the map box, in metres (so the box is 1.6 km square). */
const HALF_BOX_M = 800;
const HIGHWAYS_DENSE = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified";
const HIGHWAYS_MAIN = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link";
const HIGHWAYS_FAST = "motorway|motorway_link|trunk|trunk_link|primary|primary_link";
/** A network bigger than this is too heavy to simulate comfortably in a browser. */
const MAX_EDGES = 700;
const MIN_EDGES = 8;

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceHit[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("Place search is unavailable right now. Try again in a minute.");
  const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
  return rows.map((r) => ({ name: r.display_name, lat: Number(r.lat), lon: Number(r.lon) })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

async function overpass(query: string, signal?: AbortSignal): Promise<OsmData> {
  let lastError = "no response";
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = MIRRORS[attempt % MIRRORS.length];
    // One timer per attempt, wired to the caller's abort too, so a hung mirror can't stall the whole load.
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctl.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(`${host}/api/interpreter`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith("{")) return JSON.parse(text) as OsmData;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = ctl.signal.aborted ? "timed out" : String(e);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`The map server didn't answer (${lastError}). Try again in a minute.`);
}

export interface LoadedPlace {
  network: NetworkSnapshot;
  scenery: SceneryData;
  summary: string;
}

/** Downloads and converts the roads around a point. Falls back to fewer road types if the area is too dense to simulate. */
export async function loadPlace(hit: PlaceHit, signal?: AbortSignal): Promise<LoadedPlace> {
  const dLat = HALF_BOX_M / 110540;
  const dLon = HALF_BOX_M / (111320 * Math.cos((hit.lat * Math.PI) / 180));
  const bbox: [number, number, number, number] = [hit.lat - dLat, hit.lon - dLon, hit.lat + dLat, hit.lon + dLon];
  const box = bbox.join(",");

  for (const highways of [HIGHWAYS_DENSE, HIGHWAYS_MAIN, HIGHWAYS_FAST]) {
    const query = `[out:json][timeout:60];(way["highway"~"^(${highways})$"](${box});node["highway"="traffic_signals"](${box}););out body geom;`;
    const data = await overpass(query, signal);
    let converted;
    try {
      converted = convertOsm({ bbox, demandScale: 1 }, data);
    } catch {
      continue;
    }
    const { network, stats } = converted;
    if (stats.edges > MAX_EDGES) continue;
    if (stats.edges < MIN_EDGES || stats.entries === 0 || stats.dests === 0) {
      if (highways === HIGHWAYS_DENSE) throw new Error("There aren't enough connected roads there. Try a busier part of town.");
      continue;
    }
    // Buildings and water are a nicety: if that second request fails the roads still load.
    let scenery = EMPTY_SCENERY;
    try {
      const extra = await overpass(sceneryQuery(bbox), signal);
      scenery = convertScenery(bbox, extra.elements as never, network);
    } catch {
      if (signal?.aborted) throw new Error("cancelled");
    }
    return {
      network,
      scenery,
      summary: `${Math.round(stats.lengthMiles * 10) / 10} mi of road, ${stats.signals} traffic lights, ${stats.entries} ways in`,
    };
  }
  throw new Error("That area is too tangled to load. Try somewhere with fewer roads.");
}
