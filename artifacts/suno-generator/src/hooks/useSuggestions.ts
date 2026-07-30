import { useState, useMemo } from "react";
import type { LyricsStructure, SuggestedDefaults } from "@workspace/api-client-react";
import type { ConfirmedSection } from "@/components/LyricsStructurePanel";

export interface SuggestedControls {
  genres: string[];
  era: string | null;
  energy: string | null;
  tempo: string | null;
  vocals: string | null;
  moods: string[];
  instruments: string[];
  voices: string[];
  nudge: string | null;
  songTitle: string;
  artist: string;
  mbTags: string[];
}

/**
 * Extracted from Home.tsx (Phase 3b decomposition) — mechanical, zero intended behavior change.
 * Owns AI-suggestion / auto-fill / structure-analysis state and the one handler that's genuinely
 * self-contained (clearAutoFill). The other suggestion-adjacent handlers (resetAutoFill,
 * fetchVideoPreview, fetchSuggestionsForSong) reach into 8+ style-control setters, artist memory,
 * and several refs — moving those would mean passing nearly the entire style-control surface as
 * parameters, which isn't a meaningfully smaller unit than the (deliberately deferred) style
 * controls extraction itself. Left in Home.tsx, using this hook's exported setters, same pattern
 * as handleLoadHistory in useHistoryPanel.
 */
export function useSuggestions() {
  const [suggestions, setSuggestions] = useState<SuggestedControls | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [autoFilledFields, setAutoFilledFields] = useState<Set<string>>(new Set());
  const [autoFillValues, setAutoFillValues] = useState<Record<string, string>>({});
  const [lyricsStructure, setLyricsStructure] = useState<LyricsStructure | null>(null);
  const [confirmedStructure, setConfirmedStructure] = useState<ConfirmedSection[] | null>(null);
  const [suggestedDefaults, setSuggestedDefaults] = useState<SuggestedDefaults | null>(null);

  const clearAutoFill = (field: string) => {
    setAutoFilledFields((prev) => { const next = new Set(prev); next.delete(field); return next; });
  };

  /**
   * When structure is locked (confirmedStructure set), display the confirmed sections
   * instead of the freshly-analyzed lyricsStructure to prevent UI/payload divergence.
   */
  const displayStructure = useMemo<LyricsStructure | null>(() => {
    if (!lyricsStructure) return null;
    if (!confirmedStructure) return lyricsStructure;
    const remapped = confirmedStructure.map((cs, i) => {
      const original = lyricsStructure.sections[i];
      return {
        label: cs.label,
        lines: cs.lines,
        rhymeScheme: original?.rhymeScheme ?? "",
        sentiment: original?.sentiment ?? 0,
        isHook: original?.isHook ?? false,
        repetitionKey: original?.repetitionKey ?? "",
      };
    });
    return {
      ...lyricsStructure,
      sections: remapped,
      totalSections: remapped.length,
    };
  }, [lyricsStructure, confirmedStructure]);

  return {
    suggestions, setSuggestions,
    suggestLoading, setSuggestLoading,
    autoFilledFields, setAutoFilledFields,
    autoFillValues, setAutoFillValues,
    lyricsStructure, setLyricsStructure,
    confirmedStructure, setConfirmedStructure,
    suggestedDefaults, setSuggestedDefaults,
    clearAutoFill,
    displayStructure,
  };
}
