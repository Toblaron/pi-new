import { useState } from "react";
import { useGenerateVariations } from "@workspace/api-client-react";
import type { SunoTemplate, VariationsResponse, VariationSlot } from "@workspace/api-client-react";
import type { UsedOptions } from "@/pages/Home";

export type VariationSlotResult = SunoTemplate | null | { error: string };

/**
 * Extracted from Home.tsx (Phase 3b decomposition) — mechanical, zero behavior change.
 * Owns variation-workshop state and its two handlers. Reaches into shared cross-component state
 * (current template, error banner, history, the last-submitted URL/options) via parameters
 * rather than component scope, since those are genuinely owned elsewhere.
 */
export function useVariationWorkshop(deps: {
  lastUrlRef: React.RefObject<string>;
  lastOptionsRef: React.RefObject<object>;
  setApiError: (error: string | null) => void;
  setCurrentTemplate: (template: SunoTemplate) => void;
  addToHistory: (url: string, template: SunoTemplate, opts?: UsedOptions) => void;
}) {
  const { lastUrlRef, lastOptionsRef, setApiError, setCurrentTemplate, addToHistory } = deps;

  const variationsMutation = useGenerateVariations();
  const [variationWorkshop, setVariationWorkshop] = useState<VariationSlotResult[] | null>(null);
  const [variationPending, setVariationPending] = useState<boolean[]>([]);
  const [variationCount, setVariationCount] = useState<2 | 3 | 4>(2);
  const [isGeneratingVariations, setIsGeneratingVariations] = useState(false);

  const handleGenerateVariations = () => {
    if (!lastUrlRef.current) return;
    const count = variationCount;

    setIsGeneratingVariations(true);
    setVariationWorkshop(Array(count).fill(null));
    setVariationPending(Array(count).fill(true));
    setApiError(null);

    variationsMutation.mutate(
      {
        data: {
          youtubeUrl: lastUrlRef.current!,
          ...(lastOptionsRef.current as object),
          count,
        },
      },
      {
        onSuccess: (data: VariationsResponse) => {
          const slots = data.slots.map(
            (s: VariationSlot): VariationSlotResult =>
              s.template ? s.template : { error: s.error ?? "Generation failed" }
          );
          setVariationWorkshop(slots);
          setVariationPending([]);
          setIsGeneratingVariations(false);
        },
        onError: (err: unknown) => {
          setApiError(
            (err as { data?: { error?: string }; message?: string })?.data?.error ??
              (err as Error)?.message ??
              "Failed to generate variations"
          );
          setVariationPending([]);
          setVariationWorkshop(null);
          setIsGeneratingVariations(false);
        },
      }
    );
  };

  const handleMergeVariation = (merged: SunoTemplate) => {
    setCurrentTemplate(merged);
    setVariationWorkshop(null);
    addToHistory(lastUrlRef.current, merged);
    const allText = [
      `TITLE: ${merged.title ?? ""}`,
      `\nSTYLE OF MUSIC:\n${merged.styleOfMusic ?? ""}`,
      `\nNEGATIVE PROMPT:\n${merged.negativePrompt ?? ""}`,
      `\nLYRICS:\n${merged.lyrics ?? ""}`,
    ].join("\n");
    navigator.clipboard.writeText(allText).catch(() => undefined);
  };

  return {
    variationWorkshop,
    setVariationWorkshop,
    variationPending,
    setVariationPending,
    variationCount,
    setVariationCount,
    isGeneratingVariations,
    setIsGeneratingVariations,
    handleGenerateVariations,
    handleMergeVariation,
  };
}
