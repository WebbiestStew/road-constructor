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
  crossings, bus stops and street parking. Roads cost upkeep while traffic runs; parking brings some back.
- **A living city.** Buses and bicycles share the road, ambulances race through it, people cross at crossings (or step
  out where there isn't one), and a 24-hour cycle with rain and fog changes how everyone drives.
- **Real cities.** Seventeen levels built from actual OpenStreetMap data — the Los Angeles Four Level, Times Square,
  the Gardiner Expressway in Toronto, Houston's I-45/I-10 knot, San Antonio's "Y", downtown Monterrey, the Dallas
  High Five, Chicago's Jane Byrne Interchange, Atlanta's Spaghetti Junction, and the whole Lincoln Tunnel run: from the
  Weehawken helix, under the Hudson, across Midtown and out to Queens and Brooklyn (a thirty-minute, six-mile level with
  the real Hudson and East River). Lane counts, speed limits, bridges, tunnels, roundabouts and traffic lights are the
  real ones. Monterrey has eight spots in all: downtown, the Tec, Valle Oriente, Ciudad Universitaria, Gonzalitos by
  the Hospital Universitario, Fundidora, the Estadio BBVA and Juan Pablo II.
- **TxDOT overpasses.** On the Texas maps (Houston, San Antonio, Dallas) elevated roads are light concrete with open-slot
  Texas Classic rails and concrete bents, and the road sounds like it: the ba-dum of slab joints and a higher tyre whine.
  Everywhere else keeps asphalt decks.
- **Clover Crossing.** A cloverleaf interchange designed for the game, not taken from a map: a freeway climbs over
  another, four loops carry the left turns and four outer ramps the right turns, and the weaves between them are the
  puzzle.
- **Continuous-flow lefts.** With left turns giving way to oncoming traffic, a few waiting cars hold up a whole
  approach. The Junctions tool can displace a left turn ahead of a signalised junction: the turners cross over at a
  small signal and run with the through traffic, and nobody waits for a gap. The *Continuous Flow* level is built
  around it.
- **Gantries.** Freeway stretches carry overhead gantries (Gantries tool, `G`): post a speed advisory to smooth a
  shockwave, or close a lane with a red X, and drivers merge out a quarter mile ahead.
- **Incidents.** Stalled semis, debris and fender benders block lanes (Events menu, Chaos mode, scripted in levels like
  Clover Crossing). Tap the pin to send a wrecker, which drives the shoulder to the scene; police come to crashes on
  their own.
- **Signal phasing.** Each traffic light can run the classic two phases, a protected left-turn arrow for each direction,
  or one phase per approach, with an optional pedestrian phase and a live list of the phases and cycle length. Signal
  heads at every stop line show red, green, amber or a lone left arrow.
- **Traffic rage.** Drivers stopped for over five seconds get a red stress icon, and the angriest weave between lanes in
  free play. A chorus of muffled horns follows the fuming drivers near the camera.
- **Flow combos.** A platoon of ten cars that clears signals back to back without slowing flashes "+500 FLOW COMBO!" with
  a chime. Retime your signals into a green wave to earn them.
- **Panic events.** Trouble arrives with a siren and a ten-second banner ("OIL SPILL ON AVENIDA ... - LANE BLOCKED",
  "... 250 VEHICLES INBOUND"), in Chaos mode and in the levels' scripted events, so you can retime signals and change
  limits before it lands.
- **Depth.** Soft contact shadows under cars and bridge piers, six-inch kerbs along streets, and a punchier sun.
- **Street names.** Real street names are painted along the roads and fade in as you zoom, and the road cards show the name.
- **Soundscape.** Tyre roar near the camera (louder and brighter on wet asphalt), semis engine-braking on downgrades, and
  the expansion-joint clack on viaducts, all attenuated with distance from the camera or chase view.
- **Drone flyover.** After winning a level, a dusk-to-night flyover with time-lapsed traffic and light trails. Save a
  clip or copy a link to challenge a friend.
- **Service report and medals.** Every run is also judged on how well the city served its people: time lost per trip
  against an empty road, the longest queue, people crossing safely, crashes cleared, buses evenly spaced. Each is a medal
  (the delay and queue medals ask for a clear improvement on the level's own unchanged city, measured in the headless sim).
- **A career.** Winning pays city funds (new stars and new medals pay; replays only a trickle), funds and stars set a rank
  from Intern to Commissioner, and funds can be moved into a free-build city's budget.
- **Weather and night with consequences.** Rain lengthens braking and slows curves (and wets the pavement), fog and the
  dark make drivers cautious on unlit lanes and see people at a crossing late, so a marked crossing in the fog needs a
  lower limit, not just paint. A chip on screen says what the conditions are doing.
- **Traffic rules as tools.** Set a lane aside for buses, bikes, **carpools** (HOV) or a **toll express lane** (cars pay
  while they use it, and the money lands in your budget), **ban left or right turns** at the end of a road (drivers route
  around them, and the lane arrows follow), and **reverse a lane** on a two-way road to move capacity to the busy side.
- **Transit that bunches.** A bus stop fills with people between buses, so a late bus finds a crowd and stays longer and
  the one behind catches up. Lines can hold buses at stops to even them out, and a stop on a road two lines share is a
  transfer stop with bigger crowds.
- **Take the wheel.** Ride along with a car, then drive it: throttle and brake, lane changes that wait for a gap, a
  driver's-seat view with rain on the glass, an engine that changes gear, and a score for speeding and hard stops. On a
  phone the controls are on screen.
- **Sound mixer.** Master and group volumes (interface, traffic and weather, sirens and warnings) behind a limiter, the
  ambience ducks under a siren, and a sound check plays each sound so the mix can be balanced by ear.
- **Publish a level.** The unchanged city is measured in three spare simulations in your browser, the star and medal lines
  are set from that, and the link carries them: whoever opens it plays your city against its own unchanged score.
- **Saves and exact replays.** Eight named city slots, and replays of runs. The simulation is deterministic, so a replay is
  just the actions that shaped the run (each stamped with the sim time) played into a fresh run: bit for bit the same
  traffic, with a replay bar, a drone flyover over it, and files you can send.
- **Demand that responds.** In free play (and any level that switches it on) a road that flows draws more drivers, up to
  30% more, and a jammed one loses them, down to 55%, with some of them turning into bus riders: so "just widen it" stops
  being the whole answer. A chip shows what demand is doing.
- **Crashes that happen.** With crash risk on, a driver's mistake causes a real rear-end crash that blocks a lane until
  police arrive. The chance is tiny in calm daylight and grows with speed, rain, fog, darkness on an unlit road and
  tailgating. Finishing without one earns the Vision Zero medal.
- **Ramp meters.** Meter a ramp at 3, 5 or 8 seconds a car, or let it pace itself from how freely the freeway ahead is
  flowing. It trades ramp queues for a freer mainline, and the simulation says plainly when that is a bad trade.
- **Land use.** Place homes, jobs and shops beside the roads (Land use tool, `U`). Homes send cars out along the nearest road
  and jobs and shops are where they go, so the player designs the city and the traffic follows. Sandbox becomes a city builder.
- **People who wait.** At a crossing people wait for a gap or the button, and the waits are scored: the Walkable medal
  asks for short waits and nobody giving up and stepping out.
- **Season One.** Four story chapters on Midtown (the arena lets out, a water main closes the west avenue, a storm with
  real crash risk, and everything at once) with an introduction before and a note after, each a puzzle with fixable
  faults. Later chapters open with stars from earlier ones.
- **Any vehicle, with a radio.** Ride along with a car, truck, bus, bike or ambulance (pick the next one, or filter by
  kind) and drive it: a bus accelerates like a bus and sounds like one, an ambulance runs its siren, and the car radio has
  three generated stations (lo-fi, synthwave, dispatch chatter).
- **Community gallery and cloud backup (optional).** With a Redis store configured (the same Upstash variables as the
  leaderboard) players can post published levels to a shared gallery (browse newest or most liked, play, like, report;
  three reports hide a level) and back up their saves, stars and career under a sync code with no account. Without the
  store both are hidden. The gallery can't prove a level's measured baseline is honest: it comes from the author's browser.
- **Replay highlights.** A run notes its best moments (flow combos, a crash cleared fast, an ambulance getting through, the
  worst jam); the replay shows them as chips to jump to, each with a button that records an eight-second clip.
- **Performance test.** Settings has a "Test this device" button that measures the live scene, says which graphics tier
  fits and can apply it, and copies a plain report (graphics card, screen, frame times, what the frame-rate guard did).
- **Campaign, daily challenge and sandbox.** Hand-built levels with par-based stars, scripted trouble (a stalled
  car, a stadium letting out), a seeded daily scenario, and a no-money-limit sandbox.
- **Real merges and exits.** Where a ramp joins or leaves a bigger road, its pavement rides alongside as an added
  lane, tapers to a tip at the highway's edge and gets a hatched gore wedge; cars take the same path and enter the
  right lane. Where a road's lane count changes, its pavement eases between the two widths instead of stepping.
- **A full road builder.** Draw roads at seven elevations from tunnel to a tier-3 flyover, with grade limits and
  clearance checks.
- **Photo mode, share links, night/dusk lighting, ride-along camera, heatmap.** Save a shareable result card from any
  finished level, or record an 8-second clip of your city from photo mode.
- **Shaped vehicles and real scenery.** Cars, semis, buses, ambulances, police cars and cyclists each have their own
  model; real cities are surrounded by their actual buildings from OpenStreetMap.
- **Crashes, transit and challenges.** Crashes block a lane until police actually drive there. Draw your own bus lines.
  Turn any city into a "beat my score" link a friend can open, with no server.
- **Settings menu.** Graphics presets plus advanced toggles (shadows, bloom, vehicles, scenery, resolution, frame cap,
  car limit), sound, and accessibility options (reduce motion, larger text, bold markers). Keyboard play: N steps through
  roads for the lane, speed, street and bus-line tools; messages are announced to screen readers.
- **A cinematic tour.** One click hides the UI and flies around the city.
- **A guided first level.** *First Shift* walks a new player through the three core tools and ticks each step off by
  what they actually changed.
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

## Daily leaderboard, gallery and backup (optional)

The daily challenge can post scores to a public board. It needs a Redis database; the free Upstash tier is plenty.
Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (see `.env.example`), or add Upstash from the Vercel
Marketplace, which sets the equivalent `KV_REST_API_*` variables. Without them the game works exactly the same and
just hides the board. Scores are reported by the browser, so it is an honour-system board: the API checks that a
score is plausible and rate-limits posting, but cannot prove a run was played.

The same two variables switch on the **community gallery** (`/api/levels`) and **cloud backup** (`/api/sync`). Posting
is rate-limited and size-limited (700 KB, 2,500 roads), names are screened, and a level reported by three devices is
hidden, but that is a small net rather than moderation: someone has to be willing to look at reports. A device is
identified only by a random id kept in the browser, and a sync code is the whole key to a backup (the server stores it
only as a hash), so there are no accounts and nothing to sign in to. To try them locally, run
`npx tsx scripts/dev/mock-redis.ts` and start the dev server with
`UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=x npm run dev`.

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
  lib/        sound (with the mixer), career, service report, replays, save slots, level measuring
scripts/osm/  OpenStreetMap -> game network converter
scripts/sim/  the headless harness: baselines, behaviour checks, replay and measuring tools
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
a level can't be won by doing nothing and can't be failed by an unlucky seed. The real-city levels run with left turns
that give way to oncoming traffic (as real ones do), and their baselines, delay shares and queue lengths were measured
that way (`scripts/sim/baseline.ts`). That costs 5-10% on a busy grid, and what wins it back is modest: displaced lefts
where a road is long enough (a few percent), while protected left phases usually give up more green than they save, so
signal phasing is one lever among several, not the whole answer.

**Replays rely on determinism.** The worker logs every message that changes a run (edits, incidents, settings) with the
sim clock it was applied at (`LOGGED_TYPES` in `worker.ts`); a replay feeds that script back into a reset run. Anything
that makes a run depend on wall-clock time or an unlogged message would break it, and `scripts/sim/replay.ts` checks
that a recorded run and its replay agree trip for trip.

## Testing the simulation headlessly

Because `src/sim` has no DOM dependencies, the real worker can run in Node. That is how baselines are calibrated
and how regressions are caught: see `scripts/sim/` and run

```bash
npm run test:sim                       # the whole suite (about ten minutes)
npx tsx --test scripts/sim/unit.test.ts  # the fast pure checks
npx tsx scripts/sim/baseline.ts        # re-measure every real city's baseline (eight seeds, four at once)
npx tsx scripts/sim/measure-level.ts my-city.json   # what the Publish button does, from a file
npx tsx scripts/sim/replay.ts record /tmp/r.json && npx tsx scripts/sim/replay.ts play /tmp/r.json
npx tsx scripts/dev/mock-redis.ts      # a stand-in for the Redis store, to try the gallery and backup locally
```

## Credits

Road data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the
[ODbL](https://opendatacommons.org/licenses/odbl/). Typeface: Overpass (SIL OFL).
