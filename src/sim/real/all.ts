import type { RealCityData } from "./index";
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
 * Every real city, bundled together. Only the headless scripts and tests import this; the game loads each city on demand
 * through `loadRealCity` in ./index, so the page doesn't carry 2.4 MB of maps it may never open.
 */
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
