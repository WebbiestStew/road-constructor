/** Client side of the daily leaderboard (see src/app/api/leaderboard/route.ts). */

export interface BoardEntry {
  name: string;
  score: number;
}
export interface Board {
  /** False when the site has no leaderboard configured: the game hides the board entirely. */
  enabled: boolean;
  top: BoardEntry[];
  total: number;
}

const NAME_KEY = "road-constructor:player-name:v1";

export function loadName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    // private mode: the name just isn't remembered
  }
}

export async function fetchBoard(day: string): Promise<Board> {
  try {
    const res = await fetch(`/api/leaderboard?day=${encodeURIComponent(day)}`, { cache: "no-store" });
    if (!res.ok) return { enabled: false, top: [], total: 0 };
    const data = (await res.json()) as Partial<Board>;
    return { enabled: !!data.enabled, top: data.top ?? [], total: data.total ?? 0 };
  } catch {
    return { enabled: false, top: [], total: 0 };
  }
}

/** Posts a score. Returns the player's rank, or an error message to show them. */
export async function postScore(day: string, name: string, score: number): Promise<{ rank: number | null } | { error: string }> {
  try {
    const res = await fetch("/api/leaderboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, name, score }),
    });
    const data = (await res.json()) as { rank?: number | null; error?: string };
    if (!res.ok) return { error: data.error ?? "Couldn't post your score" };
    return { rank: data.rank ?? null };
  } catch {
    return { error: "Couldn't reach the leaderboard" };
  }
}
