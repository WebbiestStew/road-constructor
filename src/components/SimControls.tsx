"use client";

import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import type { UseScenarioRunnerReturn } from "@/hooks/useScenarioRunner";
import BudgetBar from "./hud/BudgetBar";
import BuildWarningToast from "./hud/BuildWarningToast";
import Confetti from "./hud/Confetti";
import GridlockHonk from "./hud/GridlockHonk";
import HintBar from "./hud/HintBar";
import InfoPanel from "./hud/InfoPanel";
import MobileBlockerModal from "./hud/MobileBlockerModal";
import Minimap from "./hud/Minimap";
import ModeVignette from "./hud/ModeVignette";
import OnboardingChecklist from "./hud/OnboardingChecklist";
import PausedBanner from "./hud/PausedBanner";
import PlayButton from "./hud/PlayButton";
import ScenarioHud from "./hud/ScenarioHud";
import ToolDock from "./hud/ToolDock";
import TopBar from "./hud/TopBar";
import Tutorial from "./hud/Tutorial";

export default function SimControls({
  sim,
  scenarioRunner,
}: {
  sim: UseTrafficSimulationReturn;
  scenarioRunner: UseScenarioRunnerReturn;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <ModeVignette />
      <MobileBlockerModal />
      <TopBar sim={sim} />
      <BudgetBar />
      <PlayButton sim={sim} />
      <PausedBanner sim={sim} />
      <ToolDock />
      <InfoPanel sim={sim} />
      <OnboardingChecklist />
      <HintBar />
      <BuildWarningToast />
      <Minimap />
      <Confetti sim={sim} />
      <GridlockHonk sim={sim} />
      <ScenarioHud runner={scenarioRunner} />
      <Tutorial />
    </div>
  );
}
