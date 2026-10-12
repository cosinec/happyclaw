import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { ChevronRight, Sparkles } from 'lucide-react';
import { m } from 'motion/react';
import { cn } from '@/lib/utils';
import type {
  StreamingState,
  StreamingTaskRuntimeState,
} from '../../stores/chat';
import type { StreamingStep } from '../../lib/stream-steps';
import {
  hasListedSteps,
  summarizeSettled,
  summarizedSteps,
  visibleSteps,
} from '../../lib/process-steps';
import {
  deriveHeadline,
  WAITING_HEADLINE,
  type ProcessHeadline,
} from '../../lib/process-headline';
import { formatRunElapsed } from '../../lib/run-phase';
import { useSteadyValue } from '../../hooks/useSteadyValue';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { useAfterDelay, useTick } from '../../hooks/useTick';
import { ModelWaitBody, modelWaitSeconds } from './ModelWaitRow';
import {
  LATER_WAIT_DELAY_MS,
  ProcessTimeline,
  QuestionCards,
} from './ProcessRows';

export interface ProcessCardProps {
  mode: 'live' | 'settled';
  steps: StreamingStep[];
  stepsDropped?: number;
  groupJid: string;
  /** Live only. Without it (settled) a sub-agent is a row with no details. */
  taskStates?: Record<string, StreamingTaskRuntimeState>;
  /** The input of an AskUserQuestion step. */
  activeTools?: StreamingState['activeTools'];
  /** Live: the model's request is out and nothing has come back. */
  waiting?: boolean;
  waitingSince?: number;
  hasContent?: boolean;
  /** Show the model's commentary between steps (text steps). Default true. */
  commentary?: boolean;
  /**
   * Show reasoning titles and text. Default true; off, a reasoning row only
   * says that the model reasoned, and for how long.
   */
  thinkingText?: boolean;
  /** Settled: the total time, for steps that carry no times of their own. */
  durationMs?: number;
  /** Settled: start open (the reader asked for the steps). */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** There is something of the steps to show (the timeline's own measure). */
export function hasProcess(steps: readonly StreamingStep[]): boolean {
  return hasListedSteps(steps);
}

const EMPTY_TOOLS: StreamingState['activeTools'] = [];

/** A line that changes is let settle this long before it is swapped. */
const HEADLINE_SETTLE_MS = 300;
/** The sentence read out to assistive tech changes at most this often. */
const ANNOUNCE_INTERVAL_MS = 3000;
/** Closer to the end than this, the window counts as following it. */
const FOLLOW_THRESHOLD_PX = 30;

const ICON_CLASS = 'size-3.5 shrink-0';

// ── the header ──────────────────────────────────────────────────────────

interface ProcessHeaderProps {
  mode: ProcessCardProps['mode'];
  steps: StreamingStep[];
  /** The model's request is out and nothing has come back (past its delay). */
  waiting: boolean;
  waitingSince?: number;
  thinkingText: boolean;
  durationMs?: number;
  open: boolean;
  bodyId: string;
  onToggle: () => void;
}

/**
 * The one row that is always there. Live, it says what the run is doing now
 * and for how long it has gone on; settled, what it did. It is the button
 * that opens the rest, the whole row wide, never dependent on a hover.
 */
function ProcessHeader({
  mode,
  steps,
  waiting,
  waitingSince,
  thinkingText,
  durationMs,
  open,
  bodyId,
  onToggle,
}: ProcessHeaderProps) {
  const live = mode === 'live';
  const latest = deriveHeadline({ steps, waiting, thinkingText }) ?? {
    source: 'waiting' as const,
    label: WAITING_HEADLINE,
    running: true,
    text: WAITING_HEADLINE,
  };
  const headline = useSteadyValue<ProcessHeadline>(
    latest,
    `${latest.source}|${latest.running}|${latest.text}`,
    HEADLINE_SETTLE_MS,
  );
  const announced = useThrottledValue(headline.text, ANNOUNCE_INTERVAL_MS);
  const startedAt = steps[0]?.at ?? waitingSince;
  const now = useTick(live);
  const seconds =
    startedAt != null
      ? Math.max(0, Math.floor((now - startedAt) / 1000))
      : null;

  // The first line is there from the start; only a change is animated.
  const shownOnce = useRef(false);
  useEffect(() => {
    shownOnce.current = true;
  }, []);

  const running = live && headline.running;
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        className="-mx-1.5 flex min-h-8 w-[calc(100%+0.75rem)] cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-label text-muted-foreground transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:min-h-10"
      >
        <Sparkles
          aria-hidden="true"
          className={cn(
            ICON_CLASS,
            running
              ? 'animate-pulse text-muted-foreground motion-reduce:animate-none'
              : 'text-faint-foreground',
          )}
        />
        {live ? (
          <span className="min-w-0 flex-1 overflow-hidden">
            <m.span
              key={headline.text}
              initial={shownOnce.current ? { opacity: 0, y: 6 } : false}
              animate={{ opacity: 1, y: 0 }}
              className={cn('block truncate', running && 'shimmer')}
            >
              <span
                className={cn('font-medium', !running && 'text-foreground')}
              >
                {headline.label}
              </span>
              {headline.detail && (
                <span className={cn(!running && 'text-muted-foreground')}>
                  {' · '}
                  {headline.detail}
                </span>
              )}
            </m.span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate tabular-nums">
            {summarizeSettled(steps, durationMs)}
          </span>
        )}
        {live && seconds != null && seconds >= 1 && (
          <span className="shrink-0 text-caption text-faint-foreground tabular-nums">
            {formatRunElapsed(seconds)}
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            ICON_CLASS,
            'text-faint-foreground transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
      </button>
      {live && (
        <span role="status" aria-live="polite" className="sr-only">
          {announced}
        </span>
      )}
    </>
  );
}

// ── the window ──────────────────────────────────────────────────────────

/**
 * A live card's steps in a window of limited height: it follows the end as
 * steps arrive, fades its top edge once something has scrolled out of it, and
 * lets go of the end when the reader scrolls up or opens a row to read it.
 */
function PreviewWindow({ id, children }: { id: string; children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [faded, setFaded] = useState(false);

  const follow = useCallback(() => {
    const el = scrollRef.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, []);
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    following.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
    setFaded(el.scrollTop > 1);
  }, []);

  // New steps, and a row growing as its text arrives, keep the end in view.
  useLayoutEffect(follow);
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
  }, [follow]);

  // Opening a row is reading it: the end is not followed past it. Once the
  // row has taken its place, a window still at the end follows again.
  const handleClick = () => {
    following.current = false;
    requestAnimationFrame(measure);
  };

  return (
    <div
      id={id}
      ref={scrollRef}
      onScroll={measure}
      onClickCapture={handleClick}
      data-scroll-fade={faded ? 'top' : undefined}
      data-hc-process-window=""
      className="mt-0.5 ml-1.5 max-h-60 overflow-y-auto overscroll-contain pointer-coarse:max-h-40"
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

/** The wait for the model, under the steps; it counts its own seconds. */
function WaitNote({ since, hasRows }: { since?: number; hasRows: boolean }) {
  const now = useTick(true);
  return (
    <div className={cn(hasRows && 'mt-1.5')}>
      <ModelWaitBody seconds={modelWaitSeconds(since, now)} />
    </div>
  );
}

// ── the card ────────────────────────────────────────────────────────────

/** The nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/**
 * The card folds by itself when its run ends, and what is below it moves up by
 * what it gave up. A reader who has scrolled past it, into the answer, would
 * see the text jump away from them (Safari has no scroll anchoring to hold it;
 * where there is, the net movement is what counts). So while the card is live
 * this notes where the text below it is on screen, and once it has folded the
 * scroll position takes up the difference. Not for a reader at the end of the
 * chat (the browser clamped the position to the shorter page: nothing moved on
 * screen) nor one who can see the card (what they watch is the card).
 */
function useFoldAnchor(
  ref: RefObject<HTMLElement | null>,
  mode: ProcessCardProps['mode'],
) {
  const scroller = useRef<HTMLElement | null>(null);
  const listening = useRef<HTMLElement | null>(null);
  // Where the text below the card was last seen on screen, and whether the
  // card was already above the top of the view.
  const seen = useRef<{ y: number; cardAbove: boolean } | null>(null);
  const was = useRef(mode);

  const look = useCallback(() => {
    const el = ref.current;
    const below = el?.parentElement?.lastElementChild;
    if (el && !scroller.current) scroller.current = scrollParent(el);
    if (!el || !below || below === el || !scroller.current) {
      seen.current = null;
      return;
    }
    seen.current = {
      y: below.getBoundingClientRect().top,
      cardAbove:
        el.getBoundingClientRect().bottom <=
        scroller.current.getBoundingClientRect().top,
    };
  }, [ref]);

  // Every commit, and every scroll the reader makes, while the card is live.
  useLayoutEffect(() => {
    const before = was.current;
    was.current = mode;
    const el = ref.current;
    if (mode === 'live') {
      look();
      if (scroller.current && listening.current !== scroller.current) {
        listening.current?.removeEventListener('scroll', look);
        listening.current = scroller.current;
        listening.current.addEventListener('scroll', look, { passive: true });
      }
      return;
    }
    listening.current?.removeEventListener('scroll', look);
    listening.current = null;
    const sighting = seen.current;
    const below = el?.parentElement?.lastElementChild;
    const view = scroller.current;
    seen.current = null;
    if (before !== 'live' || !sighting?.cardAbove || !below || !view) return;
    if (below === el) return;
    // Reading the position lays the folded page out; the net movement is what
    // the reader would see, whoever has moved the scroll position already.
    const drift = below.getBoundingClientRect().top - sighting.y;
    const gap = view.scrollHeight - view.scrollTop - view.clientHeight;
    if (Math.abs(drift) > 1 && gap > 1) view.scrollTop += drift;
  });
  useEffect(
    () => () => {
      listening.current?.removeEventListener('scroll', look);
      listening.current = null;
    },
    [look],
  );
}

/**
 * The process of a reply as one card, live or settled. Live, it is a headline
 * that says what the run is doing now over a window of its steps; settled, it
 * is a line that says what it did, and the same steps behind it. How it is
 * open is the reader's choice once they have made one: the card never folds
 * or opens over it.
 */
export const ProcessCard = memo(function ProcessCard({
  mode,
  steps,
  stepsDropped = 0,
  groupJid,
  taskStates,
  activeTools = EMPTY_TOOLS,
  waiting = false,
  waitingSince,
  hasContent = false,
  commentary = true,
  thinkingText = true,
  durationMs,
  defaultOpen,
  onOpenChange,
  className,
}: ProcessCardProps) {
  const live = mode === 'live';
  const shown = useMemo(
    () => visibleSteps(steps, commentary),
    [steps, commentary],
  );
  const listed = hasProcess(shown);
  // Rows to list: a question put to the reader has its own place, not a row.
  const hasRows = useMemo(() => summarizedSteps(shown).length > 0, [shown]);
  // A wait between tools shows only once it has lasted a moment.
  const waitVisible = useAfterDelay(
    live && waiting,
    hasContent ? LATER_WAIT_DELAY_MS : 0,
  );
  // What the reader chose; until then the card follows its own state.
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const bodyId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  useFoldAnchor(rootRef, mode);
  if (!listed && !waitVisible) return null;

  const open = chosen ?? (live ? true : (defaultOpen ?? false));
  const toggle = () => {
    const next = !open;
    setChosen(next);
    onOpenChange?.(next);
  };
  const timeline = (
    <ProcessTimeline
      steps={shown}
      stepsDropped={stepsDropped}
      groupJid={groupJid}
      taskStates={taskStates}
      thinkingText={thinkingText}
      live={live}
      bodyClassName={live ? 'max-h-36 pointer-coarse:max-h-24' : undefined}
      after={
        waitVisible ? (
          <WaitNote since={waitingSince} hasRows={hasRows} />
        ) : undefined
      }
    />
  );

  return (
    <div
      ref={rootRef}
      data-hc-process-card=""
      data-mode={mode}
      data-hc-model-wait={!listed && waitVisible ? '' : undefined}
      className={cn('mb-2 font-sans', className)}
    >
      <ProcessHeader
        mode={mode}
        steps={shown}
        waiting={waitVisible}
        waitingSince={waitingSince}
        thinkingText={thinkingText}
        durationMs={durationMs}
        open={open}
        bodyId={bodyId}
        onToggle={toggle}
      />
      {open &&
        (hasRows || waitVisible) &&
        (live ? (
          <PreviewWindow id={bodyId}>{timeline}</PreviewWindow>
        ) : (
          <div
            id={bodyId}
            data-hc-process-window=""
            className="mt-0.5 ml-1.5 max-h-[60vh] overflow-y-auto overscroll-contain"
          >
            {timeline}
          </div>
        ))}
      {live && <QuestionCards steps={shown} activeTools={activeTools} />}
    </div>
  );
});
