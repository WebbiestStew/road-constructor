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
import PanicBanner from "./hud/PanicBanner";
import FlowComboBanner from "./hud/FlowComboBanner";
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
import ConditionsChip from "./hud/ConditionsChip";
import DayClock from "./hud/DayClock";
import DriveHud from "./hud/DriveHud";
import ReplayBar from "./hud/ReplayBar";
import PublishLevel from "./hud/PublishLevel";
import SavesMenu from "./hud/SavesMenu";
import { useEditorStore } from "@/state/editorStore";
import WindshieldFx from "./hud/WindshieldFx";
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
  // Behind the wheel the road tools and their hints step aside, so the driving HUD has the screen.
  const driving = useEditorStore((s) => s.drivingId !== null || s.replay !== null);
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
      {!driving && <ManagerRail />}
      <PausedBanner sim={sim} />
      {!driving && <ToolDock />}
      {!driving && <InfoPanel sim={sim} />}
      {!driving && <OnboardingChecklist />}
      {!driving && <HintBar />}
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
      <PanicBanner />
      <FlowComboBanner sim={sim} />
      {!driving && <CoachBar />}
      {!driving && <GuidedTour sim={sim} />}
      <DayClock sim={sim} />
      <ConditionsChip sim={sim} />
      <WindshieldFx sim={sim} />
      <DriveHud sim={sim} />
      <ReplayBar sim={sim} />
      <SavesMenu sim={sim} />
      <PublishLevel sim={sim} runner={scenarioRunner} />
      <PlaceCredit />
      <SettingsMenu />
      <KeyboardRoads />
      <SoundScape sim={sim} />
      <EconomyTicker sim={sim} />
      <Tutorial />
    </div>
  );
}
