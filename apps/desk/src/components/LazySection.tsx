"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { observeOnce } from "@/lib/in-view";
import { Skeleton } from "@/components/ui";

/**
 * Renders its children (and so starts their data requests) only when the section is about to scroll into view. Until then it holds
 * its place with a skeleton of the given height, so nothing jumps when the content arrives. Once shown it stays shown.
 */
export function LazySection({ minHeight = 160, fallback, children }: { minHeight?: number; fallback?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    return observeOnce(el, () => setSeen(true));
  }, [seen]);
  if (seen) return <>{children}</>;
  return (
    <div ref={ref} style={{ minHeight }} aria-hidden="true">
      {fallback ?? <Skeleton className="h-full w-full" />}
    </div>
  );
}
