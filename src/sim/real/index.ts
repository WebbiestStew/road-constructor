import type { NetworkSnapshot } from "../types";
import type { SceneryData } from "../osm/scenery";
import losAngeles from "./los-angeles.json";
import monterrey from "./monterrey.json";
import newYork from "./new-york.json";
import houston from "./houston.json";
import sanAntonio from "./san-antonio.json";
import toronto from "./toronto.json";
import dallas from "./dallas.json";
import chicago from "./chicago.json";
import atlanta from "./atlanta.json";
import lincolnTunnel from "./lincoln-tunnel.json";
import monterreyTec from "./monterrey-tec.json";
import monterreyValleOriente from "./monterrey-valle-oriente.json";
import monterreyUanl from "./monterrey-uanl.json";
import monterreyHospitalUniversitario from "./monterrey-hospital-universitario.json";
import monterreyFundidora from "./monterrey-fundidora.json";
import monterreyEstadio from "./monterrey-estadio.json";
import monterreyJuanPabloIi from "./monterrey-juan-pablo-ii.json";

/**
 * Real road networks baked from OpenStreetMap by scripts/osm/build.ts: real geometry, lane counts, speed limits,
 * bridge and tunnel heights, and traffic signals. Map data © OpenStreetMap contributors (ODbL).
 */
export interface RealCityData {
  meta: { key: string; name: string; bbox: [number, number, number, number]; attribution: string; generated: string };
  network: NetworkSnapshot;
  /** Real building footprints and water from OpenStreetMap, drawn around the roads. */
  scenery?: SceneryData;
}

export const REAL_CITY_DATA = {
  "los-angeles": losAngeles,
  "new-york": newYork,
  toronto,
  houston,
  "san-antonio": sanAntonio,
  monterrey,
  dallas,
  chicago,
  atlanta,
  "lincoln-tunnel": lincolnTunnel,
  "monterrey-tec": monterreyTec,
  "monterrey-valle-oriente": monterreyValleOriente,
  "monterrey-uanl": monterreyUanl,
  "monterrey-hospital-universitario": monterreyHospitalUniversitario,
  "monterrey-fundidora": monterreyFundidora,
  "monterrey-estadio": monterreyEstadio,
  "monterrey-juan-pablo-ii": monterreyJuanPabloIi,
} as unknown as Record<string, RealCityData>;

export const OSM_ATTRIBUTION = "Map data © OpenStreetMap contributors (ODbL)";
