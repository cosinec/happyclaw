import type { ComponentType } from 'react';
import { ChevronRight, ListTree, Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChatStore, type Message } from '../../stores/chat';

/** The same collapsed row the loaded reasoning and trace use, as a button. */
const ROW_CLASS =
  '-ml-1.5 inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-caption text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:cursor-default pointer-coarse:h-10';

function LazyRow({
  icon: Icon,
  label,
  loading,
  failed,
  onClick,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
  label: string;
  loading: boolean;
  failed: boolean;
  onClick: () => void;
}) {
  return (
    <div className="mb-2 font-sans">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        aria-busy={loading}
        className={ROW_CLASS}
      >
        {loading ? (
          <Loader2
            className="size-3.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ) : (
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="shrink-0">{label}</span>
        {failed && !loading && (
          <span className="min-w-0 truncate text-faint-foreground">
            · 暂时无法加载，点击重试
          </span>
        )}
        <ChevronRight
          className={cn('size-3.5 shrink-0', loading && 'opacity-0')}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

/**
 * The reasoning and execution details of a reply this tab did not stream
 * (after a reload, or on an older page of the history): the server kept them,
 * so they show as the same two collapsed rows, loaded when one is opened. The
 * rows give way to the real ones once the caches hold the turn.
 */
export function LazyTurnTrace({
  message,
  reasoning,
  onRequest,
}: {
  message: Pick<Message, 'id' | 'chat_jid' | 'turn_id'>;
  /** The server keeps reasoning text for this workspace (not just activity). */
  reasoning: boolean;
  /** Which row asked, so the loaded block opens at once. */
  onRequest: (row: 'thinking' | 'trace') => void;
}) {
  const status = useChatStore((s) => s.turnTraceStatus[message.id]);
  const loadTurnTrace = useChatStore((s) => s.loadTurnTrace);
  if (status === 'empty') return null;
  const loading = status === 'loading';
  const failed = status === 'failed';
  const ask = (row: 'thinking' | 'trace') => () => {
    onRequest(row);
    void loadTurnTrace(message);
  };
  return (
    <>
      {reasoning && (
        <LazyRow
          icon={Sparkles}
          label="思考过程"
          loading={loading}
          failed={failed}
          onClick={ask('thinking')}
        />
      )}
      <LazyRow
        icon={ListTree}
        label="执行详情"
        loading={loading}
        failed={failed && !reasoning}
        onClick={ask('trace')}
      />
    </>
  );
}
