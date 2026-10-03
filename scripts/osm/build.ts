/**
 * Turns a box of real OpenStreetMap roads into a Road Constructor network.
 *
 *   npx tsx scripts/osm/build.ts            # every city
 *   npx tsx scripts/osm/build.ts toronto    # one city
 *
 * Raw downloads are cached in scripts/osm/cache/ (git-ignored); the result is written to src/sim/real/<key>.json.
 * Map data © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright).
 */
import fs from "node:fs";
import path from "node:path";
import { convertOsm } from "../../src/sim/osm/convert";
import { convertScenery, coastlineWater, sceneryQuery } from "../../src/sim/osm/scenery";
import { CITIES, type CityConfig } from "./cities";

// Run from the repo root (see usage above), so paths are relative to it.
const CACHE_DIR = path.join(process.cwd(), "scripts/osm/cache");
const OUT_DIR = path.join(process.cwd(), "src/sim/real");
const MIRRORS = ["https://overpass-api.de", "https://lz4.overpass-api.de", "https://z.overpass-api.de"];
const USER_AGENT = "road-constructor-scenario-builder/1.0 (https://github.com/WebbiestStew/road-constructor)";


// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

import type { OsmData } from "../../src/sim/osm/convert";
async function overpass(query: string): Promise<OsmData> {
  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const host = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(`${host}/api/interpreter`, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, Accept: "*/*", "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith("{")) return JSON.parse(text) as OsmData;
      lastError = `${host}: HTTP ${res.status}`;
    } catch (e) {
      lastError = `${host}: ${String(e)}`;
    }
    await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
  }
  throw new Error(`Overpass failed (${lastError})`);
}

async function download(city: CityConfig): Promise<OsmData> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${city.key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as OsmData;
  const [s, w, n, e] = city.bbox;
  const bbox = `${s},${w},${n},${e}`;
  const hw = city.highways.join("|");
  // A corridor city downloads only the roads near its route, as a polyline filter, instead of the whole box.
  const filters = city.corridor
    ? city.corridor.lines.map((line) => `(around:${city.corridor!.meters},${line.map(([la, lo]) => `${la},${lo}`).join(",")})`)
    : [`(${bbox})`];
  const ways = filters.map((f) => `way["highway"~"^(${hw})$"]${f};`).join("");
  const lights = filters.map((f) => `node["highway"="traffic_signals"]${f};`).join("");
  const query = `[out:json][timeout:180];(${ways}${lights});out body geom;`;
  console.log(`  downloading ${city.name}…`);
  const data = await overpass(query);
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

async function downloadScenery(city: CityConfig): Promise<OsmData> {
  const file = path.join(CACHE_DIR, `${city.key}.scenery.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as OsmData;
  console.log(`  downloading ${city.name} buildings and water…`);
  const data = await overpass(sceneryQuery(city.bbox));
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

async function downloadCoast(city: CityConfig): Promise<OsmData> {
  const file = path.join(CACHE_DIR, `${city.key}.coast.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as OsmData;
  const [s, w, n, e] = city.bbox;
  const data = await overpass(`[out:json][timeout:90];way["natural"="coastline"](${s},${w},${n},${e});out geom;`);
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

async function buildCity(city: CityConfig) {
  const data = await download(city);
  const { network, stats } = convertOsm(city, data);
  const scenery = convertScenery(city.bbox, (await downloadScenery(city)).elements as never, network);
  if (city.coastline) {
    // Rivers and bays: stitched from the coastline, since big water is a relation the footprint query skips.
    const coast = await downloadCoast(city);
    const water = coastlineWater(city.bbox, coast.elements as never);
    console.log(`  ${city.name}: ${water.length} water polygons from the coastline`);
    scenery.water.push(...water);
  }
  const meta = {
    key: city.key,
    name: city.name,
    bbox: city.bbox,
    attribution: "Map data © OpenStreetMap contributors (ODbL)",
    generated: new Date().toISOString().slice(0, 10),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${city.key}.json`);
  fs.writeFileSync(file, JSON.stringify({ meta, network, scenery }));
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(
    `  ${city.name.padEnd(12)} ${stats.edges} edges, ${stats.nodes} nodes, ${Math.round(stats.lengthMiles)} mi of road, ` +
      `${stats.signals} signals, ${stats.entries} entries/${stats.dests} dests, ${scenery.buildings.length} buildings, ${scenery.water.length} water, ` +
      `extent ${Math.round(stats.extentFt[0])}×${Math.round(stats.extentFt[1])} ft, ${stats.elevationLevels} elevation levels, ${kb} KB`
  );
}

async function main() {
  const only = process.argv[2];
  for (const city of CITIES.filter((c) => !only || c.key === only)) {
    await buildCity(city);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
