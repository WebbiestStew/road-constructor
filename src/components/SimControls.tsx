"use client";

import type { UseTrafficSimulationReturn } from "@/hooks/useTrafficSimulation";
import type { UseScenarioRunnerReturn } from "@/hooks/useScenarioRunner";
import BudgetBar from "./hud/BudgetBar";
import BuildWarningToast from "./hud/BuildWarningToast";
import Confetti from "./hud/Confetti";
import GridlockHonk from "./hud/GridlockHonk";
import HintBar from "./hud/HintBar";
import InfoPanel from "./hud/InfoPanel";
import TouchTip from "./hud/TouchTip";
import Minimap from "./hud/Minimap";
import ModeVignette from "./hud/ModeVignette";
import OnboardingChecklist from "./hud/OnboardingChecklist";
import PausedBanner from "./hud/PausedBanner";
import PlayButton from "./hud/PlayButton";
import ScenarioHud from "./hud/ScenarioHud";
import ManagerRail from "./hud/ManagerRail";
import ToolDock from "./hud/ToolDock";
import TopBar from "./hud/TopBar";
import QualityNotice from "./hud/QualityNotice";
import ToastHost from "./hud/ToastHost";
import FlowFeedback from "./hud/FlowFeedback";
import ChaosDirector from "./hud/ChaosDirector";
import ScriptedEventAnnouncer from "./hud/ScriptedEventAnnouncer";
import CoachBar from "./hud/CoachBar";
import EmergencyAnnouncer from "./hud/EmergencyAnnouncer";
import WeatherFx from "./hud/WeatherFx";
import PlaceCredit from "./hud/PlaceCredit";
import SoundScape from "./hud/SoundScape";
import EconomyTicker from "./hud/EconomyTicker";
import GuidedTour from "./hud/GuidedTour";
import SettingsMenu from "./hud/SettingsMenu";
import KeyboardRoads from "./KeyboardRoads";
import DayClock from "./hud/DayClock";
import PhotoOverlay from "./hud/PhotoOverlay";
import CinematicOverlay from "./hud/CinematicOverlay";
import { useFlyover } from "@/lib/cinematic";
import { usePhotoMode } from "@/lib/photoMode";
import Tutorial from "./hud/Tutorial";

export default function SimControls({
  sim,
  scenarioRunner,
}: {
  sim: UseTrafficSimulationReturn;
  scenarioRunner: UseScenarioRunnerReturn;
}) {
  const photo = usePhotoMode();
  const flyover = useFlyover();
  // Photo mode: a clean frame. Toasts stay (for "saved"); everything else steps aside.
  if (photo) {
    return (
      <div className="pointer-events-none absolute inset-0 z-10">
        {flyover ? <CinematicOverlay info={flyover} /> : <PhotoOverlay />}
        <ToastHost />
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <WeatherFx sim={sim} />
      <ModeVignette />
      <TouchTip />
      <TopBar sim={sim} />
      <BudgetBar />
      <PlayButton sim={sim} />
      <ManagerRail />
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
      <QualityNotice />
      <ToastHost />
      <FlowFeedback sim={sim} />
      <ChaosDirector sim={sim} />
      <EmergencyAnnouncer sim={sim} />
      <ScriptedEventAnnouncer runner={scenarioRunner} />
      <CoachBar />
      <GuidedTour sim={sim} />
      <DayClock sim={sim} />
      <PlaceCredit />
      <SettingsMenu />
      <KeyboardRoads />
      <SoundScape sim={sim} />
      <EconomyTicker sim={sim} />
      <Tutorial />
    </div>
  );
}
