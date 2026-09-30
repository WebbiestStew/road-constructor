import { ELEVATION_BY_ID, ROAD_CLASSES, ROUNDABOUT_LANE_WIDTH_FT, ROUNDABOUT_SPEED_MPH } from "./roadClasses";
import type { ElevationLevelId } from "./roadClasses";
import { Builder, type Vec3 } from "./cityBuilder";
import type { NetworkSnapshot, ZoneSpec } from "./types";

/**
 * The hand-built city behind the landing page hero. It is assembled in "build
 * stages" so the page can replay how a player would construct it — avenue,
 * neighborhoods (signal + roundabout), then a viaduct — before opening it to
 * traffic. It never touches the editor store, so it can't clobber a player's save.
 */

export const DEMO_STAGE_COUNT = 3;

export interface DemoCity {
  /** The finished network, handed to the simulation. */
  full: NetworkSnapshot;
  /** `stages[i]` is the slice of the network that appears in build step i. */
  stages: NetworkSnapshot[];
}

const ENTRY = (vph: number): ZoneSpec => ({ type: "entry", demandVehPerHour: vph });
const DEST: ZoneSpec = { type: "destination", targetSpeedMph: 25 };

let cached: DemoCity | null = null;

export function getDemoCity(): DemoCity {
  if (cached) return cached;
  const b = new Builder();

  const VIADUCT_Y = ELEVATION_BY_ID.viaduct.elevationFt;

  // ---- Stage 0: the avenue (N-S, x = 0) ----------------------------------
  const RING_CENTER: [number, number] = [0, -700];
  const RING_R = 72;
  // Ring nodes sit on the avenue/street legs at N, E, S, W (same order the editor uses: ascending angle).
  const ringAngles = { N: -Math.PI / 2, E: 0, S: Math.PI / 2, W: Math.PI };
  const ring = (k: keyof typeof ringAngles) =>
    [RING_CENTER[0] + Math.cos(ringAngles[k]) * RING_R, RING_CENTER[1] + Math.sin(ringAngles[k]) * RING_R] as const;

  b.node("aN", 0, -1800);
  b.node("rN", ...ring("N"));
  b.node("rE", ...ring("E"));
  b.node("rS", ...ring("S"));
  b.node("rW", ...ring("W"));

  const sigX = 0;
  const sigZ = 720;
  b.node("aSig", sigX, sigZ);
  b.node("aS", 0, 1800);

  b.road(0, "av1", "aN", "rN", "avenue", "ground", { forward: ENTRY(650), backward: DEST });
  b.road(0, "av2", "rS", "aSig", "avenue");
  b.road(0, "av3", "aSig", "aS", "avenue", "ground", { forward: DEST, backward: ENTRY(650) });

  // ---- Stage 1: neighbourhoods — roundabout, signal, side streets ---------
  b.node("wEnd1", -1000, RING_CENTER[1]);
  b.node("eEnd1", 1000, RING_CENTER[1]);
  b.road(1, "st1", "wEnd1", "rW", "street", "ground", { forward: ENTRY(380), backward: DEST });
  b.road(1, "st2", "rE", "eEnd1", "street", "ground", { forward: DEST, backward: ENTRY(380) });

  b.node("wEnd2", -1000, sigZ);
  b.node("eEnd2", 1000, sigZ);
  b.road(1, "st3", "wEnd2", "aSig", "street", "ground", { forward: ENTRY(380), backward: DEST });
  b.road(1, "st4", "aSig", "eEnd2", "street", "ground", { forward: DEST, backward: ENTRY(380) });

  // Roundabout ring: one lane, ascending-angle order, bowed out through the arc midpoint.
  const order: (keyof typeof ringAngles)[] = ["N", "E", "S", "W"];
  order.forEach((k, i) => {
    const next = order[(i + 1) % order.length];
    const mid = ringAngles[k] + Math.PI / 4;
    b.edges.push({
      id: `ring${k}`,
      fromNodeId: `r${k}`,
      toNodeId: `r${next}`,
      interiorPoints: [[RING_CENTER[0] + Math.cos(mid) * RING_R, 0, RING_CENTER[1] + Math.sin(mid) * RING_R]],
      roadClassId: "lane",
      elevationLevelId: "ground",
      lanes: 1,
      laneWidthFt: ROUNDABOUT_LANE_WIDTH_FT,
      speedLimitMph: ROUNDABOUT_SPEED_MPH,
      isRoundaboutRing: true,
    });
    b.stageOfEdge.set(`ring${k}`, 1);
  });

  // Signal at the south crossroads: avenue phase vs. street phase.
  const sigNode = b.nodes.get("aSig")!;
  sigNode.control = {
    type: "signal",
    groupA: ["av2f", "av3b"],
    groupB: ["st3f", "st4b"],
    greenDurationS: 14,
    allRedDurationS: 2,
  };

  // ---- Stage 2: the motorway on a viaduct, flying over the avenue ---------
  // Two separate one-way carriageways (no shared nodes), so nothing can U-turn mid-motorway.
  const lanes = ROAD_CLASSES.motorway;
  const oneWay = (id: string, from: string, to: string, elevation: ElevationLevelId, zone?: ZoneSpec, interior?: Vec3[]) => {
    b.edges.push({
      id,
      fromNodeId: from,
      toNodeId: to,
      interiorPoints: interior ?? [],
      roadClassId: "motorway",
      elevationLevelId: elevation,
      lanes: lanes.lanesPerDirection,
      laneWidthFt: lanes.laneWidthFt,
      speedLimitMph: lanes.speedLimitMph,
      ...(zone ? { zone } : {}),
    });
    b.stageOfEdge.set(id, 2);
  };
  const CARRIAGEWAY_OFFSET = 24;
  const carriageway = (dir: "e" | "w", z: number) => {
    const sign = dir === "e" ? 1 : -1;
    const xs = [-2100, -1150, -650, 650, 1150, 2100].map((x) => x * sign);
    const ys = [0, 0, VIADUCT_Y, VIADUCT_Y, 0, 0];
    const ids = xs.map((x, i) => b.node(`m${dir}${i}`, x, z, ys[i]));
    oneWay(`mo${dir}1`, ids[0], ids[1], "ground", ENTRY(1400));
    oneWay(`mo${dir}2`, ids[1], ids[2], "viaduct", undefined, b.ramp(ids[1], ids[2], 4));
    oneWay(`mo${dir}3`, ids[2], ids[3], "viaduct", undefined, [
      [216 * sign * -1, VIADUCT_Y, z],
      [216 * sign, VIADUCT_Y, z],
    ]);
    oneWay(`mo${dir}4`, ids[3], ids[4], "viaduct", undefined, b.ramp(ids[3], ids[4], 4));
    oneWay(`mo${dir}5`, ids[4], ids[5], "ground", DEST);
  };
  carriageway("e", CARRIAGEWAY_OFFSET);
  carriageway("w", -CARRIAGEWAY_OFFSET);

  const stages = Array.from({ length: DEMO_STAGE_COUNT }, (_, i) => b.slice(i));
  cached = {
    full: { nodes: [...b.nodes.values()], edges: b.edges },
    stages,
  };
  return cached;
}

/** Straight road centerlines of the demo city (x1, z1, x2, z2), for keeping scenery off the roads. */
export function getDemoRoadSegments(): [number, number, number, number][] {
  const { full } = getDemoCity();
  const byId = new Map(full.nodes.map((n) => [n.id, n]));
  return full.edges.map((e) => {
    const a = byId.get(e.fromNodeId)!.position;
    const z = byId.get(e.toNodeId)!.position;
    return [a[0], a[2], z[0], z[2]];
  });
}
