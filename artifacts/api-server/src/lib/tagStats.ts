import { listEntries } from "./historyStore.js";

export type TagCategory = "genre" | "mood" | "instrument";

export interface TagStat {
  tag: string;
  category: TagCategory;
  count: number;
  avgRating: number;
}

interface UsedOptionsShape {
  genres?: string[];
  moods?: string[];
  instruments?: string[];
}

const CATEGORY_FIELDS: { field: keyof UsedOptionsShape; category: TagCategory }[] = [
  { field: "genres", category: "genre" },
  { field: "moods", category: "mood" },
  { field: "instruments", category: "instrument" },
];

/** Average star rating per genre/mood/instrument tag, computed from rated history entries.
 * Tags used fewer than minCount times are dropped — too little signal to be meaningful. */
export function computeTagStats(minCount = 2, limit = 500): TagStat[] {
  const rated = listEntries(limit).filter((e) => typeof e.rating === "number");

  const agg = new Map<string, { category: TagCategory; tag: string; count: number; sum: number }>();

  for (const entry of rated) {
    const opts = entry.usedOptions as UsedOptionsShape | undefined;
    const rating = entry.rating as number;
    for (const { field, category } of CATEGORY_FIELDS) {
      const values = opts?.[field];
      if (!values) continue;
      for (const tag of values) {
        const key = `${category}:${tag}`;
        const existing = agg.get(key) ?? { category, tag, count: 0, sum: 0 };
        existing.count += 1;
        existing.sum += rating;
        agg.set(key, existing);
      }
    }
  }

  const stats: TagStat[] = [];
  for (const v of agg.values()) {
    if (v.count < minCount) continue;
    stats.push({
      tag: v.tag,
      category: v.category,
      count: v.count,
      avgRating: Math.round((v.sum / v.count) * 10) / 10,
    });
  }

  return stats.sort((a, b) => b.avgRating - a.avgRating || b.count - a.count);
}
