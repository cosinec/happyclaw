import { Sparkles } from 'lucide-react';
import { useAfterDelay, useTick } from '../../hooks/useTick';
import { formatRunElapsed } from '../../lib/run-phase';

/**
 * The model is at work and nothing has come back yet: a quiet row with how
 * long this request has taken and a few skeleton lines where its words will
 * be. The first wait of a reply shows at once; a short one between tools only
 * once it has lasted a moment, so a quick turn does not flash it.
 */
export function ModelWaitRow({
  active,
  since,
  delayMs = 0,
}: {
  active: boolean;
  /** When this request began (ms). */
  since?: number;
  delayMs?: number;
}) {
  const visible = useAfterDelay(active, delayMs);
  const now = useTick(visible);
  if (!visible) return null;
  const seconds =
    since != null ? Math.max(0, Math.floor((now - since) / 1000)) : null;
  return (
    <div className="mb-2 font-sans" data-hc-model-wait="">
      <div className="-ml-1.5 flex h-7 items-center gap-1.5 px-1.5 text-caption text-muted-foreground pointer-coarse:h-10">
        <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="shimmer">正在思考…</span>
        {seconds != null && seconds >= 1 && (
          <span className="text-faint-foreground tabular-nums">
            {formatRunElapsed(seconds)}
          </span>
        )}
      </div>
      <div
        aria-hidden="true"
        className="mt-1 space-y-2 border-l-2 border-surface-border py-0.5 pl-3"
      >
        <div className="h-3 w-3/4 animate-pulse rounded bg-surface-selected" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-surface-selected" />
      </div>
    </div>
  );
}
