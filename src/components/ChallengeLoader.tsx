"use client";

import { useEffect, useRef } from "react";
import type { UseScenarioRunnerReturn } from "@/hooks/useScenarioRunner";
import { CHALLENGE_HASH_PREFIX, challengerName, decodeChallenge, onMakeChallenge, setActiveChallenge } from "@/lib/challenge";
import { buildChallengeScenario, buildPublishedScenario, getScenarioById } from "@/sim/scenarios";
import { useEditorStore } from "@/state/editorStore";
import { pushToast } from "@/lib/toast";

/**
 * Opens a "beat my score" link (a `#challenge=` hash) as soon as the game loads, and starts a custom challenge when the
 * player asks to turn their own city into one. Renders nothing.
 */
export default function ChallengeLoader({ runner }: { runner: UseScenarioRunnerReturn }) {
  const startRef = useRef(runner.startScenario);
  useEffect(() => {
    startRef.current = runner.startScenario;
  }, [runner.startScenario]);

  // A link in the address bar when the page opens.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith(CHALLENGE_HASH_PREFIX)) return;
    void decodeChallenge(hash.slice(CHALLENGE_HASH_PREFIX.length)).then((p) => {
      history.replaceState(null, "", window.location.pathname + window.location.search);
      if (!p) {
        pushToast("That challenge link looks corrupted or out of date", "bad");
        return;
      }
      if (p.kind === "level") {
        const def = getScenarioById(p.id);
        if (!def) {
          pushToast("That challenge uses a level this version doesn't have", "bad");
          return;
        }
        startRef.current(def);
        setActiveChallenge({ scenarioId: def.id, from: p.from, target: p.target });
      } else if (p.kind === "published") {
        const key = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
        const def = buildPublishedScenario({
          key,
          name: p.name,
          network: p.network,
          baseline: p.baseline,
          service: p.delayShare !== undefined && p.queueFt !== undefined ? { delayShare: p.delayShare, queueFt: p.queueFt } : undefined,
          mix: { bus: p.bus ?? 0, bike: p.bike ?? 0 },
          from: p.from,
        });
        startRef.current(def);
        setActiveChallenge(null);
        pushToast(`📤 ${p.from} published “${p.name}”: the unchanged city moves ${p.baseline}. Beat it`, "info");
        return;
      } else {
        const key = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
        const def = buildChallengeScenario({ key, name: p.name, network: p.network, target: p.target, from: p.from });
        startRef.current(def);
        setActiveChallenge({ scenarioId: def.id, from: p.from, target: p.target });
      }
      pushToast(`⚔️ ${p.from} challenged you to beat ${p.target}`, "info");
    });
  }, []);

  // The player turning their own city into a challenge.
  useEffect(
    () =>
      onMakeChallenge(() => {
        const s = useEditorStore.getState();
        const hasEntry = s.edges.some((e) => e.zone?.type === "entry");
        const hasDest = s.edges.some((e) => e.zone?.type === "destination");
        if (!hasEntry || !hasDest) {
          pushToast("Add at least one entry and one destination first (Zone tool), so there's traffic to score", "alert");
          return;
        }
        const key = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
        const def = buildChallengeScenario({ key, name: `${challengerName()}'s city`, network: { nodes: s.nodes, edges: s.edges }, target: 0 });
        startRef.current(def);
        setActiveChallenge(null);
        pushToast("🏁 Open it to traffic and play it once. That sets the score your friends try to beat", "info");
      }),
    []
  );

  return null;
}
