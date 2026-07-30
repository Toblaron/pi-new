import { useState, useRef } from "react";
import type { SunoTemplate } from "@workspace/api-client-react";
import type { UsedOptions } from "@/pages/Home";
import { scoreTemplate } from "@/lib/promptScorer";

export interface HistoryEntry {
  id: string;
  timestamp: number;
  youtubeUrl: string;
  template: SunoTemplate;
  rating?: number | null;
  usedOptions?: UsedOptions;
  qualityScore?: number;
  collection?: string;
}

interface ServerHistoryEntry {
  id: string;
  createdAt: number;
  youtubeUrl: string;
  songTitle?: string;
  artist?: string;
  thumbnail?: string;
  template: unknown;
  rating?: number | null;
  qualityScore?: number | null;
  usedOptions?: unknown;
}

const HISTORY_KEY = "suno-template-history";
const MAX_HISTORY = 10;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
  } catch {}
}

/** Fire-and-forget: persist a history entry to the server SQLite store. */
function syncEntryToServer(entry: HistoryEntry, videoPreview?: { thumbnail?: string | null }) {
  const body = {
    id: entry.id,
    createdAt: entry.timestamp,
    youtubeUrl: entry.youtubeUrl,
    songTitle: entry.template.songTitle ?? undefined,
    artist: entry.template.artist ?? undefined,
    thumbnail: videoPreview?.thumbnail ?? undefined,
    template: entry.template,
    rating: entry.rating ?? null,
    qualityScore: entry.qualityScore ?? null,
    usedOptions: entry.usedOptions ?? undefined,
  };
  fetch("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {/* ignore — server may not be reachable */});
}

/** Fire-and-forget: sync a rating update to the server. */
function syncRatingToServer(id: string, rating: number | null) {
  fetch(`/api/history/${encodeURIComponent(id)}/rating`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating }),
  }).catch(() => {});
}

/** Merge server history entries into localStorage-loaded entries (dedup by id, keep most recent). */
function mergeHistories(local: HistoryEntry[], server: ServerHistoryEntry[]): HistoryEntry[] {
  const byId = new Map<string, HistoryEntry>();
  for (const e of local) byId.set(e.id, e);
  for (const s of server) {
    if (!byId.has(s.id)) {
      byId.set(s.id, {
        id: s.id,
        timestamp: s.createdAt,
        youtubeUrl: s.youtubeUrl,
        template: s.template as SunoTemplate,
        rating: s.rating ?? null,
        qualityScore: s.qualityScore ?? undefined,
        usedOptions: s.usedOptions as UsedOptions | undefined,
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_HISTORY);
}

/**
 * Extracted from Home.tsx (Phase 3b decomposition) — mechanical, zero intended behavior change.
 * Owns history/rating state and its handlers. Needs the current style-control selection (to
 * build UsedOptions for a saved entry) and videoPreview (for the thumbnail synced to the server)
 * as parameters, same pattern as the other extracted hooks — this file has no self-contained
 * state clusters.
 */
export function useHistoryPanel(deps: {
  videoPreview: { thumbnail?: string | null } | null;
  selectedGenres: string[];
  selectedMoods: string[];
  selectedInstruments: string[];
  selectedVoices: string[];
  vocalGender: string;
  energyLevel: string;
  era: string;
  tempo: string | null;
}) {
  const { videoPreview, selectedGenres, selectedMoods, selectedInstruments, selectedVoices, vocalGender, energyLevel, era, tempo } = deps;

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyMinRating, setHistoryMinRating] = useState<number>(0);
  const [historyCollectionFilter, setHistoryCollectionFilter] = useState("");
  const [templateRating, setTemplateRating] = useState<number | null>(null);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [ratingSaved, setRatingSaved] = useState(false);
  const ratingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Called once on mount: loads localStorage history, then merges in server history in the background. */
  const loadAndMergeHistory = () => {
    const local = loadHistory();
    setHistory(local);
    fetch("/api/history?limit=50")
      .then((r) => r.ok ? r.json() as Promise<{ entries: ServerHistoryEntry[] }> : Promise.resolve({ entries: [] }))
      .then(({ entries }) => {
        if (entries.length === 0) return;
        setHistory((prev) => {
          const merged = mergeHistories(prev, entries);
          saveHistory(merged);
          return merged;
        });
      })
      .catch(() => {/* server may not be available */});
  };

  const extractUsedOptions = (): UsedOptions => ({
    genres: selectedGenres.length > 0 ? selectedGenres : undefined,
    moods: selectedMoods.length > 0 ? selectedMoods : undefined,
    instruments: selectedInstruments.length > 0 ? selectedInstruments : undefined,
    voices: selectedVoices.length > 0 ? selectedVoices : undefined,
    vocalGender: vocalGender !== "auto" ? vocalGender : undefined,
    energyLevel: energyLevel !== "auto" ? energyLevel : undefined,
    era: era !== "auto" ? era : undefined,
    tempo: tempo ?? undefined,
  });

  const buildFeedbackContext = (): string | undefined => {
    const rated = history.filter((e) => typeof e.rating === "number");
    if (rated.length < 2) return undefined;

    const liked = rated.filter((e) => typeof e.rating === "number" && e.rating! >= 4);
    const disliked = rated.filter((e) => typeof e.rating === "number" && e.rating! <= 2);

    const countMap = <T extends string>(entries: HistoryEntry[], field: keyof UsedOptions): Map<T, number> => {
      const map = new Map<T, number>();
      entries.forEach((e) => {
        const vals = e.usedOptions?.[field] as T[] | undefined;
        vals?.forEach((v) => map.set(v, (map.get(v) ?? 0) + 1));
      });
      return map;
    };

    const topN = <T extends string>(map: Map<T, number>, n = 4): T[] =>
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

    const parts: string[] = [];

    if (liked.length > 0) {
      const g = topN(countMap<string>(liked, "genres"));
      const m = topN(countMap<string>(liked, "moods"));
      const inst = topN(countMap<string>(liked, "instruments"));
      const segments: string[] = [];
      if (g.length) segments.push(`genres: ${g.join(", ")}`);
      if (m.length) segments.push(`moods: ${m.join(", ")}`);
      if (inst.length) segments.push(`instruments: ${inst.join(", ")}`);
      if (segments.length) parts.push(`LIKED (lean toward these): ${segments.join("; ")}`);
    }

    if (disliked.length > 0) {
      const g = topN(countMap<string>(disliked, "genres"));
      const m = topN(countMap<string>(disliked, "moods"));
      const inst = topN(countMap<string>(disliked, "instruments"));
      const segments: string[] = [];
      if (g.length) segments.push(`genres: ${g.join(", ")}`);
      if (m.length) segments.push(`moods: ${m.join(", ")}`);
      if (inst.length) segments.push(`instruments: ${inst.join(", ")}`);
      if (segments.length) parts.push(`DISLIKED (avoid or deprioritise these): ${segments.join("; ")}`);
    }

    return parts.length > 0
      ? `User star ratings (1–5 scale; ≥4 = liked, ≤2 = disliked) from ${rated.length} past templates — ${parts.join(". ")}.`
      : undefined;
  };

  const addToHistory = (url: string, template: SunoTemplate, opts?: UsedOptions) => {
    const { overall: qualityScore } = scoreTemplate(template);
    const entry: HistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      youtubeUrl: url,
      template,
      rating: null,
      usedOptions: opts,
      qualityScore,
    };
    setHistory((prev) => {
      const next = [entry, ...prev.filter((e) => e.youtubeUrl !== url)].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
    syncEntryToServer(entry, videoPreview ?? undefined);
  };

  const rateCurrentTemplate = (rating: number) => {
    const newRating = templateRating === rating ? null : rating;
    setTemplateRating(newRating);
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.map((e, i) =>
        i === 0
          ? { ...e, rating: newRating, usedOptions: e.usedOptions ?? extractUsedOptions() }
          : e
      );
      saveHistory(next);
      if (next[0]) syncRatingToServer(next[0].id, newRating);
      return next;
    });
    if (ratingTimerRef.current) clearTimeout(ratingTimerRef.current);
    setRatingSaved(true);
    ratingTimerRef.current = setTimeout(() => setRatingSaved(false), 2000);
  };

  const handleClearHistory = () => {
    setHistory([]);
    saveHistory([]);
    fetch("/api/history", { method: "DELETE" }).catch(() => {});
  };

  const handleBulkExport = async () => {
    try {
      const resp = await fetch("/api/history/export");
      if (!resp.ok) throw new Error("Export failed");
      const data = await resp.json() as unknown;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "suno-history.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: export from localStorage
      const blob = new Blob([JSON.stringify(history, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "suno-history.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const handleUpdateCollection = async (entryId: string, collection: string) => {
    try {
      await fetch(`/api/history/${encodeURIComponent(entryId)}/collection`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection }),
      });
    } catch { /* ignore */ }
    setHistory((prev) => {
      const next = prev.map((e) => e.id === entryId ? { ...e, collection } : e);
      saveHistory(next);
      return next;
    });
  };

  return {
    history, setHistory,
    showHistory, setShowHistory,
    historySearch, setHistorySearch,
    historyMinRating, setHistoryMinRating,
    historyCollectionFilter, setHistoryCollectionFilter,
    templateRating, setTemplateRating,
    hoverRating, setHoverRating,
    ratingSaved, setRatingSaved,
    loadAndMergeHistory,
    extractUsedOptions,
    buildFeedbackContext,
    addToHistory,
    rateCurrentTemplate,
    handleClearHistory,
    handleBulkExport,
    handleUpdateCollection,
  };
}
