import { ROAD_CLASSES } from "./roadClasses";
import type { ElevationLevelId, RoadClassId } from "./roadClasses";
import { computeSignalPhaseGroups } from "./network";
import type { EdgeSpec, NetworkSnapshot, NodeSpec, ZoneSpec } from "./types";

export type Vec3 = [number, number, number];

export class Builder {
  nodes = new Map<string, NodeSpec>();
  edges: EdgeSpec[] = [];
  stageOfEdge = new Map<string, number>();

  node(id: string, x: number, z: number, y = 0, control?: NodeSpec["control"]): string {
    this.nodes.set(id, { id, position: [x, y, z], ...(control ? { control } : {}) });
    return id;
  }

  /** A two-way road as a pair of opposite one-way edges, like the editor makes. Returns [forward id, backward id]. */
  road(
    stage: number,
    id: string,
    from: string,
    to: string,
    cls: RoadClassId,
    elevation: ElevationLevelId = "ground",
    zones?: { forward?: ZoneSpec; backward?: ZoneSpec },
    interior?: Vec3[]
  ): [string, string] {
    const c = ROAD_CLASSES[cls];
    const make = (eid: string, a: string, b: string, pts: Vec3[], zone?: ZoneSpec) => {
      this.edges.push({
        id: eid,
        fromNodeId: a,
        toNodeId: b,
        interiorPoints: pts,
        roadClassId: cls,
        elevationLevelId: elevation,
        lanes: c.lanesPerDirection,
        laneWidthFt: c.laneWidthFt,
        speedLimitMph: c.speedLimitMph,
        ...(zone ? { zone } : {}),
      });
      this.stageOfEdge.set(eid, stage);
    };
    const pts = interior ?? [];
    make(`${id}f`, from, to, pts, zones?.forward);
    make(`${id}b`, to, from, [...pts].reverse(), zones?.backward);
    return [`${id}f`, `${id}b`];
  }

  /** Eased interior points so a ramp between two heights reads as a smooth climb, not a kinked ramp. */
  ramp(from: string, to: string, steps = 3): Vec3[] {
    const a = this.nodes.get(from)!.position;
    const b = this.nodes.get(to)!.position;
    const pts: Vec3[] = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / (steps + 1);
      const e = t * t * (3 - 2 * t);
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * t]);
    }
    return pts;
  }

  /** Stage-i slice: its edges plus only the nodes they reference. */
  slice(stage: number): NetworkSnapshot {
    const edges = this.edges.filter((e) => this.stageOfEdge.get(e.id) === stage);
    const used = new Set<string>();
    for (const e of edges) {
      used.add(e.fromNodeId);
      used.add(e.toNodeId);
    }
    return { nodes: [...this.nodes.values()].filter((n) => used.has(n.id)), edges };
  }
}

/** Gives a junction a traffic light, grouping approaches into two phases by heading like the editor does. */
export function addSignal(b: Builder, nodeId: string, greenDurationS = 20, allRedDurationS = 2): void {
  const { groupA, groupB } = computeSignalPhaseGroups(nodeId, b.edges, b.nodes);
  const node = b.nodes.get(nodeId)!;
  node.control = { type: "signal", groupA, groupB, greenDurationS, allRedDurationS };
}
