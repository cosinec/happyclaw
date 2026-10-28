import { RunStatusBar } from '../../src/components/chat/RunStatusBar';
import { useChatStore } from '../../src/stores/chat';

/**
 * Where the composer's `statusBar` slot holds the run status bar once ChatView
 * passes it: just above the composer, in the message column. The harnesses
 * mount it here meanwhile.
 */
export function HarnessRunStatusBar({ groupJid }: { groupJid: string }) {
  const agentId = useChatStore((s) => s.activeAgentTab[groupJid] ?? null);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--composer-dock-height,8.75rem)+var(--composer-dock-lift,0px))] z-30 mx-auto w-full max-w-3xl px-4 lg:px-6 [&_button]:pointer-events-auto">
      <RunStatusBar groupJid={groupJid} agentId={agentId} />
    </div>
  );
}
