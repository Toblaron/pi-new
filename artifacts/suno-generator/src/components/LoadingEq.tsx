import { motion } from "framer-motion";

const STAGE_LABELS: Record<string, string> = {
  metadata: "Fetching metadata",
  lyrics: "Fetching lyrics",
  "ai-generating": "Generating with AI",
  validating: "Validating output",
};

export function LoadingEq({ stage }: { stage?: string | null }) {
  const label = (stage && STAGE_LABELS[stage]) || "Analyzing · Synthesizing · Generating";
  return (
    <div className="flex flex-col items-center justify-center gap-5 py-16">
      <div className="flex items-end justify-center gap-1 h-10">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <motion.div
            key={i}
            className="w-1.5 bg-primary"
            animate={{ height: ["15%", "100%", "15%"] }}
            transition={{
              duration: 0.9,
              repeat: Infinity,
              delay: i * 0.1,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>
      <p className="text-[11px] font-mono uppercase tracking-widest text-primary/60 animate-pulse">
        {label}
      </p>
    </div>
  );
}
