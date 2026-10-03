import fs from "node:fs";
import { coastlineWater, makeProjector } from "../../src/sim/osm/scenery";
const bbox: [number, number, number, number] = [40.695, -74.04, 40.775, -73.935];
const coast = JSON.parse(fs.readFileSync("scripts/osm/cache/lincoln-tunnel.coast.json", "utf8"));
const water = coastlineWater(bbox, coast.elements);
const project = makeProjector(bbox);
const inside = (poly: number[], x: number, z: number) => {
  let c = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], zi = poly[i + 1], xj = poly[j], zj = poly[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
console.log("polygons", water.length, water.map((p) => p.length / 2));
for (const [name, lat, lon, want] of [
  ["Midtown (land)", 40.758, -73.985, false],
  ["Hudson midstream (water)", 40.762, -74.012, true],
  ["Weehawken (land)", 40.7706, -74.0282, false],
  ["Queens LIC (land)", 40.745, -73.945, false],
  ["East River (water)", 40.7515, -73.9615, true],
  ["Brooklyn (land)", 40.7, -73.97, false],
  ["Hoboken (land)", 40.745, -74.03, false],
] as [string, number, number, boolean][]) {
  const p = project(lat, lon);
  const hit = water.some((poly) => inside(poly, p.x, p.z));
  console.log(name.padEnd(28), hit ? "water" : "land ", hit === want ? "ok" : "WRONG");
}
