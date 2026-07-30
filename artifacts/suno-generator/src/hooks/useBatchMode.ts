import { useState, useRef, useCallback } from "react";
import type { BatchTrackResult, PlaylistTrack, SunoTemplate } from "@workspace/api-client-react";

/**
 * Extracted from Home.tsx (Phase 3b decomposition) — mechanical, zero intended behavior change.
 * Owns batch/playlist state and its handlers. Reaches into shared cross-component state (error
 * banner, current template, variation workshop, and the full style-control selection) via
 * parameters rather than component scope, since those are genuinely owned elsewhere.
 *
 * Incidental fix noted during extraction: the original handleStartBatch/handleBatchRetry were
 * wrapped in useCallback with a dependency array that omitted `selectedVoices` despite reading
 * it (stale-closure risk — voice selection could lag behind other style-control changes in batch
 * mode). Since these are plain functions here, not manually-tracked useCallbacks, that bug goes
 * away as a side effect rather than being deliberately fixed — flagging it rather than silently
 * folding it into a "mechanical" extraction.
 */
export function useBatchMode(deps: {
  setApiError: (error: string | null) => void;
  setCurrentTemplate: (template: SunoTemplate | null) => void;
  setVariationWorkshop: (v: null) => void;
  vocalGender: string;
  energyLevel: string;
  era: string;
  mode: "cover" | "inspired" | null;
  selectedGenres: string[];
  selectedMoods: string[];
  selectedInstruments: string[];
  selectedVoices: string[];
  excludeTags: string[];
  genreNudge: string;
}) {
  const {
    setApiError, setCurrentTemplate, setVariationWorkshop,
    vocalGender, energyLevel, era, mode,
    selectedGenres, selectedMoods, selectedInstruments, selectedVoices, excludeTags, genreNudge,
  } = deps;

  const [batchMode, setBatchMode] = useState(false);
  const [batchUrlsText, setBatchUrlsText] = useState("");
  const [batchTracks, setBatchTracks] = useState<BatchTrackResult[] | null>(null);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [playlistPreview, setPlaylistPreview] = useState<PlaylistTrack[] | null>(null);
  const [playlistCapped, setPlaylistCapped] = useState(false);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const batchAbortRef = useRef<AbortController | null>(null);

  const parseBatchUrls = useCallback((text: string): string[] => {
    const lines = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    return lines.filter((url) => url.includes("youtube.com") || url.includes("youtu.be"));
  }, []);

  const detectPlaylistUrl = useCallback((text: string): string | null => {
    const lines = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    // Scan all lines for a playlist URL (list= param), not just the first
    for (const line of lines) {
      try {
        const u = new URL(line);
        if (u.searchParams.get("list")) return line;
      } catch { /* not a valid URL, skip */ }
    }
    return null;
  }, []);

  const fetchPlaylistPreview = useCallback(async (playlistUrl: string) => {
    setPlaylistLoading(true);
    setPlaylistError(null);
    setPlaylistPreview(null);
    try {
      const apiBase = import.meta.env.BASE_URL.replace(/\/$/, "");
      const resp = await fetch(`${apiBase}/api/playlist-info?url=${encodeURIComponent(playlistUrl)}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: "Failed to fetch playlist" })) as { error?: string };
        throw new Error(body.error ?? "Failed to fetch playlist");
      }
      const data = await resp.json() as { tracks: PlaylistTrack[]; totalCount: number; capped: boolean };
      setPlaylistPreview(data.tracks);
      setPlaylistCapped(data.capped);
      setBatchUrlsText(data.tracks.map((t) => t.url).join("\n"));
    } catch (err) {
      setPlaylistError((err as Error).message ?? "Failed to load playlist");
    } finally {
      setPlaylistLoading(false);
    }
  }, []);

  const buildStyleControlBody = () => ({
    vocalGender: vocalGender !== "auto" ? vocalGender : undefined,
    energyLevel: energyLevel !== "auto" ? energyLevel : undefined,
    era: era !== "auto" ? era : undefined,
    mode: mode ?? undefined,
    genres: selectedGenres.length > 0 ? selectedGenres : undefined,
    moods: selectedMoods.length > 0 ? selectedMoods : undefined,
    instruments: selectedInstruments.length > 0 ? selectedInstruments : undefined,
    voices: selectedVoices.length > 0 ? selectedVoices : undefined,
    excludeTags: excludeTags.length > 0 ? excludeTags : undefined,
    genreNudge: genreNudge.trim() || undefined,
  });

  const handleStartBatch = async () => {
    const apiBase = import.meta.env.BASE_URL.replace(/\/$/, "");

    // Seed metadata map from any existing playlist preview
    const metaByUrl = new Map<string, { title?: string; thumbnail?: string }>(
      playlistPreview?.map((t) => [t.url, { title: t.title, thumbnail: t.thumbnail }]) ?? []
    );

    // If input contains a playlist URL, expand it first before proceeding
    const playlistUrl = detectPlaylistUrl(batchUrlsText);
    let resolvedText = batchUrlsText;
    if (playlistUrl) {
      setPlaylistLoading(true);
      setPlaylistError(null);
      try {
        const resp = await fetch(`${apiBase}/api/playlist-info?url=${encodeURIComponent(playlistUrl)}`);
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({ error: "Failed to fetch playlist" })) as { error?: string };
          setPlaylistError(body.error ?? "Failed to fetch playlist");
          setPlaylistLoading(false);
          return;
        }
        const data = await resp.json() as { tracks: PlaylistTrack[]; totalCount: number; capped: boolean };
        setPlaylistPreview(data.tracks);
        setPlaylistCapped(data.capped);
        // Build expanded URLs from playlist tracks, preserving the metadata
        data.tracks.forEach((t) => metaByUrl.set(t.url, { title: t.title, thumbnail: t.thumbnail }));
        // Merge: replace the playlist URL with expanded track URLs; keep other individual URLs
        const nonPlaylistUrls = parseBatchUrls(batchUrlsText).filter(
          (u) => !u.includes("list=")
        );
        const expandedUrls = data.tracks.map((t) => t.url);
        const merged = [...new Set([...expandedUrls, ...nonPlaylistUrls])].slice(0, 20);
        resolvedText = merged.join("\n");
        setBatchUrlsText(resolvedText);
      } catch (err) {
        setPlaylistError((err as Error).message ?? "Failed to load playlist");
        setPlaylistLoading(false);
        return;
      } finally {
        setPlaylistLoading(false);
      }
    }

    const urls = parseBatchUrls(resolvedText);
    if (urls.length === 0) {
      setApiError("No valid YouTube URLs found. Paste video URLs, one per line.");
      return;
    }
    if (urls.length > 20) {
      setApiError("Maximum 20 URLs per batch. Please trim your list.");
      return;
    }

    batchAbortRef.current?.abort();
    const abort = new AbortController();
    batchAbortRef.current = abort;

    setIsBatchRunning(true);
    setApiError(null);
    setCurrentTemplate(null);
    setVariationWorkshop(null);

    const videoIdFromUrl = (u: string): string => {
      const m = u.match(/(?:v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
      return m ? m[1] : "";
    };

    const initialTracks: BatchTrackResult[] = urls.map((url, index) => {
      const meta = metaByUrl.get(url);
      const videoId = videoIdFromUrl(url);
      return {
        url,
        videoId,
        status: "queued",
        index,
        // Pre-seed title and thumbnail from playlist preview if available
        title: meta?.title,
        thumbnail: meta?.thumbnail ?? (videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : undefined),
      };
    });
    setBatchTracks(initialTracks);

    try {
      const resp = await fetch(`${apiBase}/api/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls, ...buildStyleControlBody() }),
        signal: abort.signal,
      });

      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => "Unknown error");
        throw new Error(text);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const event of events) {
          const line = event.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as { type: string; track?: BatchTrackResult };
            if (msg.type === "progress" && msg.track) {
              setBatchTracks((prev) => {
                if (!prev) return prev;
                const next = [...prev];
                next[msg.track!.index] = msg.track!;
                return next;
              });
            }
          } catch {}
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setApiError((err as Error).message ?? "Batch generation failed");
      }
    } finally {
      setIsBatchRunning(false);
    }
  };

  const handleBatchRetry = (track: BatchTrackResult) => {
    const urls = [track.url];
    setBatchTracks((prev) =>
      prev ? prev.map((t) => t.index === track.index ? { ...t, status: "queued" } : t) : prev
    );

    const retryTrack: BatchTrackResult = { ...track, status: "analyzing" };
    setBatchTracks((prev) =>
      prev ? prev.map((t) => t.index === track.index ? retryTrack : t) : prev
    );

    const apiBase = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${apiBase}/api/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, ...buildStyleControlBody() }),
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) {
          const errMsg = !resp.ok
            ? (await resp.json().catch(() => ({ error: "Retry failed" })) as { error?: string }).error ?? "Retry failed"
            : "No response body";
          setBatchTracks((prev) =>
            prev ? prev.map((t) => t.index === track.index ? { ...t, status: "failed", error: errMsg } : t) : prev
          );
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop() ?? "";
          for (const event of events) {
            const line = event.replace(/^data: /, "").trim();
            if (!line) continue;
            try {
              const msg = JSON.parse(line) as { type: string; track?: BatchTrackResult };
              if (msg.type === "progress" && msg.track) {
                const updatedTrack = { ...msg.track, index: track.index };
                setBatchTracks((prev) =>
                  prev ? prev.map((t) => t.index === track.index ? updatedTrack : t) : prev
                );
              }
            } catch {}
          }
        }
      })
      .catch(() => {
        setBatchTracks((prev) =>
          prev ? prev.map((t) => t.index === track.index ? { ...t, status: "failed", error: "Retry failed" } : t) : prev
        );
      });
  };

  return {
    batchMode, setBatchMode,
    batchUrlsText, setBatchUrlsText,
    batchTracks, setBatchTracks,
    isBatchRunning, setIsBatchRunning,
    playlistPreview, setPlaylistPreview,
    playlistCapped, setPlaylistCapped,
    playlistLoading, setPlaylistLoading,
    playlistError, setPlaylistError,
    batchAbortRef,
    parseBatchUrls,
    detectPlaylistUrl,
    fetchPlaylistPreview,
    handleStartBatch,
    handleBatchRetry,
  };
}
