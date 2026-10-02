# Road Constructor

**The city is built. The traffic is a mess. Make it flow.**

A free, in-browser 3D traffic-management game. You don't build the city — you fix its traffic: lane arrows,
speed limits and signal timing, while every car drives for real. Play it on desktop or phone, no sign-up.

![Landing page with the live 3D hero](docs/landing.jpg)

## What's in it

- **A real traffic simulation.** Every vehicle follows the Intelligent Driver Model (IDM) for car-following and
  MOBIL for lane changes, running in a Web Worker at 30 Hz so the UI never stalls.
- **Traffic Manager tools** (in the spirit of TM:PE): per-lane turn arrows, speed limits, signal groups, priority
  junctions, signal *offsets* so you can build a green wave, bus and bike lanes, one-way streets and pedestrian
  crossings.
- **A living city.** Buses and bicycles share the road, ambulances race through it, people cross at crossings (or step
  out where there isn't one), and a 24-hour cycle with rain and fog changes how everyone drives.
- **Real cities.** Nine levels built from actual OpenStreetMap data — the Los Angeles Four Level, Times Square,
  the Gardiner Expressway in Toronto, Houston's I-45/I-10 knot, San Antonio's "Y", downtown Monterrey, the Dallas
  High Five, Chicago's Jane Byrne Interchange and Atlanta's Spaghetti Junction.
  Lane counts, speed limits, bridges, tunnels, roundabouts and traffic lights are the real ones.
- **Campaign, daily challenge and sandbox.** Hand-built levels with par-based stars, scripted trouble (a stalled
  car, a stadium letting out), a seeded daily scenario, and a no-money-limit sandbox.
- **A full road builder.** Draw roads at seven elevations from tunnel to a tier-3 flyover, with grade limits and
  clearance checks.
- **Photo mode, share links, night/dusk lighting, ride-along camera, heatmap.**
- **Runs cool on weak machines.** Three quality tiers, an adaptive frame limiter that idles when nothing moves,
  and an auto-downgrade if the frame rate drops.
- **Works on phones.** One finger pans, two fingers pinch and rotate, tap to build.

| | |
|---|---|
| ![Los Angeles](docs/la.jpg) | ![Houston](docs/hou.jpg) |
| ![Midtown Manhattan](docs/nyc.jpg) | |

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
npm run build && npm start
```

Next.js 16 / React 19 / React Three Fiber / Zustand / Tailwind 4. No backend; progress is stored in
`localStorage`, and layouts can be shared as a link (`#data=…`, compressed and schema-validated with zod).

## How it works

```
src/
  sim/        pure TypeScript simulation — no React, no DOM
    worker.ts     the 30 Hz loop: spawning, IDM, MOBIL, signals, events, stats
    network.ts    turns an edge/node graph into splines, lanes and lane-to-lane moves
    idm.ts        car following
    scenarios.ts  campaign levels, challenge scoring, the daily scenario
    real/         city networks baked from OpenStreetMap (see below)
  state/      Zustand editor store (network, budget, undo/redo) and persistence
  components/ the R3F scene (roads, vehicles, terrain) and the HUD
  hooks/      worker bridge and scenario runner
scripts/osm/  OpenStreetMap -> game network converter
```

**The worker protocol is small.** The main thread sends network and edit patches
(`updateNetwork`, `patchEdges`, `patchNodes`, `scheduleEvents`, …); the worker streams back vehicle snapshots and
a stats object every 200 ms. Snapshots stop entirely while paused.

**Performance choices worth knowing about:** the canvas runs with `frameloop="never"` and a custom limiter, so a
paused or idle game costs almost nothing; road geometry is memoized per edge; vehicles are instanced; and the
headless harness described below made it possible to measure all of this rather than guess.

## Real cities from OpenStreetMap

`scripts/osm/build.ts` downloads a bounding box from Overpass, clips and splits the ways at junctions, maps OSM
road classes to game classes, derives bridge/tunnel heights from `layer`/`bridge`/`tunnel` tags, places signals
from `highway=traffic_signals`, finds entries and exits at the box boundary, drops disconnected fragments, and
writes `src/sim/real/<city>.json`. The results are committed, so nothing is fetched at runtime.

```bash
npx tsx scripts/osm/build.ts            # all cities
npx tsx scripts/osm/build.ts houston    # one city
```

Add a city by adding a bounding box to `scripts/osm/cities.ts`, running the script, and adding a plan to
`REAL_PLANS` in `src/sim/scenarios.ts`.

Star targets are relative to each city's own baseline — what the unchanged network moves in five minutes — so
a level can't be won by doing nothing and can't be failed by an unlucky seed.

## Testing the simulation headlessly

Because `src/sim` has no DOM dependencies, the real worker can run in Node. That is how baselines are calibrated
and how regressions are caught: see `scripts/sim/` and run

```bash
npm run test:sim
```

## Credits

Road data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the
[ODbL](https://opendatacommons.org/licenses/odbl/). Typeface: Overpass (SIL OFL).
