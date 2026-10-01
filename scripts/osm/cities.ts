/**
 * The real places the "Real cities" levels are built from. Each is a fixed box of OpenStreetMap roads, downloaded
 * once by scripts/osm/build.ts and baked into src/sim/real/<key>.json — nothing is fetched while playing.
 * bbox is [south, west, north, east] in degrees.
 */
export interface CityConfig {
  key: string;
  name: string;
  bbox: [number, number, number, number];
  /** Which OSM highway classes to import. Downtown grids want the small streets too; freeway interchanges don't. */
  highways: string[];
  /** Scales every entry's demand, tuned per city so the unmodified network is properly stressed. */
  demandScale: number;
}

const FREEWAY = ["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link"];
const ARTERIAL = [...FREEWAY, "secondary", "secondary_link"];
const GRID = [...ARTERIAL, "tertiary", "tertiary_link"];
/** Dense downtown grids: the avenues and the numbered streets between them. */
const CITY_STREETS = [...GRID, "residential", "unclassified"];

export const CITIES: CityConfig[] = [
  // Downtown LA: the Four Level Interchange where US-101 meets the Harbor Freeway.
  { key: "los-angeles", name: "Los Angeles", bbox: [34.0478, -118.2680, 34.0585, -118.2540], highways: FREEWAY, demandScale: 1 },
  // Midtown Manhattan around Times Square: one-way avenues and streets, signal after signal.
  { key: "new-york", name: "New York", bbox: [40.7545, -73.9915, 40.7620, -73.9795], highways: CITY_STREETS, demandScale: 1 },
  // Toronto's waterfront: the Gardiner Expressway and Lake Shore Boulevard east of downtown.
  { key: "toronto", name: "Toronto", bbox: [43.6395, -79.3790, 43.6500, -79.3640], highways: ARTERIAL, demandScale: 1 },
  // Houston: where I-45 meets I-10 just north of downtown, the densest knot of ramps in the city.
  { key: "houston", name: "Houston", bbox: [29.7635, -95.3715, 29.7745, -95.3565], highways: FREEWAY, demandScale: 1 },
  // San Antonio: just north of downtown, where I-35, I-10 and US-281 all come together.
  { key: "san-antonio", name: "San Antonio", bbox: [29.4330, -98.4880, 29.4440, -98.4720], highways: FREEWAY, demandScale: 1 },
  // Monterrey: the Macroplaza grid and Avenida Constitución downtown.
  { key: "monterrey", name: "Monterrey", bbox: [25.6660, -100.3200, 25.6760, -100.3040], highways: CITY_STREETS, demandScale: 1 },
];
