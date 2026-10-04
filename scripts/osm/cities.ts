/**
 * The real places the "Real cities" levels are built from. Each is a fixed box of OpenStreetMap roads, downloaded
 * once by scripts/osm/build.ts and baked into src/sim/real/<key>.json — nothing is fetched while playing.
 * bbox is [south, west, north, east] in degrees.
 */
import type { ConvertConfig } from "../../src/sim/osm/convert";

export interface CityConfig {
  key: string;
  name: string;
  bbox: [number, number, number, number];
  /** Which OSM highway classes to import. Downtown grids want the small streets too; freeway interchanges don't. */
  highways: string[];
  /** Scales every entry's demand, tuned per city so the unmodified network is properly stressed. */
  demandScale: number;
  /** See ConvertConfig.zoneRegions. */
  zoneRegions?: ConvertConfig["zoneRegions"];
  /** See ConvertConfig.mainRoadZonesOnly. */
  mainRoadZonesOnly?: boolean;
  /** Also build rivers and bays from the coastline (for a box with a lot of water in it). */
  coastline?: boolean;
  /** Only download roads within `corridorMeters` of these [lat, lon] polylines (a long route through a big box). */
  corridor?: { lines: [number, number][][]; meters: number };
}

const FREEWAY = ["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link"];
const ARTERIAL = [...FREEWAY, "secondary", "secondary_link"];
const GRID = [...ARTERIAL, "tertiary", "tertiary_link"];
/** Dense downtown grids: the avenues and the numbered streets between them. */
const CITY_STREETS = [...GRID, "residential", "unclassified"];

export const CITIES: CityConfig[] = [
  // Downtown LA: the Four Level Interchange where US-101 meets the Harbor Freeway.
  { key: "los-angeles", name: "Los Angeles", bbox: [34.0478, -118.2680, 34.0585, -118.2540], highways: FREEWAY, demandScale: 1.6 },
  // Midtown Manhattan around Times Square: one-way avenues and streets, signal after signal.
  { key: "new-york", name: "New York", bbox: [40.7545, -73.9915, 40.7620, -73.9795], highways: CITY_STREETS, demandScale: 1 },
  // Toronto's waterfront: the Gardiner Expressway and Lake Shore Boulevard east of downtown.
  { key: "toronto", name: "Toronto", bbox: [43.6395, -79.3790, 43.6500, -79.3640], highways: ARTERIAL, demandScale: 1 },
  // Houston: where I-45 meets I-10 just north of downtown, the densest knot of ramps in the city.
  { key: "houston", name: "Houston", bbox: [29.7635, -95.3715, 29.7745, -95.3565], highways: FREEWAY, demandScale: 1.9 },
  // San Antonio: just north of downtown, where I-35, I-10 and US-281 all come together.
  { key: "san-antonio", name: "San Antonio", bbox: [29.4330, -98.4880, 29.4440, -98.4720], highways: FREEWAY, demandScale: 1 },
  // Monterrey: the Macroplaza grid and Avenida Constitución downtown.
  { key: "monterrey", name: "Monterrey", bbox: [25.6660, -100.3200, 25.6760, -100.3040], highways: CITY_STREETS, demandScale: 1 },
  // Dallas: the High Five, where I-635 meets US-75 on five stacked levels.
  { key: "dallas", name: "Dallas", bbox: [32.9150, -96.7790, 32.9335, -96.7490], highways: FREEWAY, demandScale: 2 },
  // Chicago: the Jane Byrne (Circle) Interchange, where the Kennedy, Dan Ryan and Eisenhower meet.
  { key: "chicago", name: "Chicago", bbox: [41.8705, -87.6525, 41.8805, -87.6385], highways: FREEWAY, demandScale: 1 },
  // Atlanta: the Tom Moreland ("Spaghetti Junction") interchange of I-85 and I-285.
  { key: "atlanta", name: "Atlanta", bbox: [33.8865, -84.2665, 33.8970, -84.2515], highways: FREEWAY, demandScale: 1.4 },
  // Lincoln Tunnel: from the Weehawken helix in New Jersey, under the Hudson, across Midtown, to Queens and Brooklyn.
  // Traffic only comes in from the New Jersey edge and only leaves on the Queens (east) and Brooklyn (south) edges.
  {
    key: "lincoln-tunnel",
    name: "Lincoln Tunnel",
    coastline: true,
    bbox: [40.695, -74.04, 40.775, -73.935],
    highways: ARTERIAL,
    demandScale: 0.3,
    corridor: {
      meters: 420,
      lines: [
        // New Jersey, the Weehawken helix, the tunnel under the Hudson, out at 39th Street.
        [[40.7642, -74.04], [40.7667, -74.03], [40.766, -74.02], [40.764, -74.018], [40.7615, -74.01], [40.76, -74.001], [40.759, -73.9985]],
        // Across Midtown on 42nd and 34th Streets to the Queens-Midtown Tunnel, and on into Queens.
        [[40.759, -73.9985], [40.756, -73.988], [40.7535, -73.979], [40.7515, -73.973], [40.748, -73.9715], [40.745, -73.965], [40.743, -73.956], [40.742, -73.94]],
        // The Queensboro Bridge.
        [[40.7535, -73.979], [40.759, -73.964], [40.758, -73.952], [40.756, -73.942]],
        // Down the east side to the Williamsburg, Manhattan and Brooklyn bridges (Brooklyn).
        [[40.7515, -73.973], [40.738, -73.974], [40.725, -73.978], [40.714, -73.98], [40.709, -73.991], [40.704, -73.996], [40.698, -73.995]],
        [[40.7137, -73.973], [40.712, -73.96], [40.71, -73.945]],
      ],
    },
    zoneRegions: {
      entry: (_lat, lon) => lon < -74.026,
      // Queens: the Queens-Midtown Tunnel, Queensboro Bridge and the expressways beyond them. Brooklyn: the roads at the
      // southern tip that carry on to the Brooklyn, Manhattan and Brooklyn-Battery crossings.
      dest: (lat, lon) => lon > -73.948 || (lat < 40.716 && lon < -73.975),
      entryScale: 1,
    },
  },
  // Tecnológico de Monterrey: Avenida Eugenio Garza Sada, the campus entrances and the streets behind them.
  { key: "monterrey-tec", name: "Monterrey Tec", bbox: [25.6464, -100.2975, 25.6564, -100.2815], highways: CITY_STREETS, demandScale: 1.6, mainRoadZonesOnly: true },
  // Valle Oriente, in San Pedro: Lázaro Cárdenas, Fundadores and the malls' ramps.
  { key: "monterrey-valle-oriente", name: "Monterrey Valle Oriente", bbox: [25.6329, -100.3207, 25.6429, -100.3047], highways: CITY_STREETS, demandScale: 1.6, mainRoadZonesOnly: true },
  // Ciudad Universitaria of the UANL, where Avenida Universidad meets Fidel Velázquez and Nogalar.
  { key: "monterrey-uanl", name: "Monterrey UANL", bbox: [25.7263, -100.3160, 25.7363, -100.3000], highways: CITY_STREETS, demandScale: 0.6, mainRoadZonesOnly: true },
  // Gonzalitos by the Hospital Universitario, with Madero and Paseo de los Leones.
  { key: "monterrey-hospital-universitario", name: "Monterrey Hospital Universitario", bbox: [25.6861, -100.3606, 25.6961, -100.3446], highways: CITY_STREETS, demandScale: 2.2, mainRoadZonesOnly: true },
  // Parque Fundidora: Avenida Fundidora, Cristóbal Colón and the Madero ramps.
  { key: "monterrey-fundidora", name: "Monterrey Fundidora", bbox: [25.6736, -100.2925, 25.6836, -100.2765], highways: CITY_STREETS, demandScale: 1, mainRoadZonesOnly: true },
  // Estadio BBVA in Guadalupe: Pablo Livas, Las Torres and Exposición.
  { key: "monterrey-estadio", name: "Monterrey Estadio", bbox: [25.6644, -100.2524, 25.6744, -100.2364], highways: CITY_STREETS, demandScale: 2.5, mainRoadZonesOnly: true },
  // Avenida Universidad at Juan Pablo II and Jorge A. Treviño, in the north of the city.
  { key: "monterrey-juan-pablo-ii", name: "Monterrey Juan Pablo II", bbox: [25.7411, -100.3049, 25.7511, -100.2889], highways: CITY_STREETS, demandScale: 1, mainRoadZonesOnly: true },
];
