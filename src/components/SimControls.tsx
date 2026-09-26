"use client";

import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import BudgetBar from "./hud/BudgetBar";
import HintBar from "./hud/HintBar";
import InfoPanel from "./hud/InfoPanel";
import Minimap from "./hud/Minimap";
import PlayButton from "./hud/PlayButton";
import ToolDock from "./hud/ToolDock";
import TopBar from "./hud/TopBar";

export default function SimControls({ sim }: { sim: UseTrafficSimulationReturn }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <TopBar sim={sim} />
      <BudgetBar />
      <PlayButton sim={sim} />
      <ToolDock />
      <InfoPanel sim={sim} />
      <HintBar />
      <Minimap />
    </div>
  );
}
