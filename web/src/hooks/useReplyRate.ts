import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chat';
import {
  isWritingReply,
  replyRate,
  trackReplyText,
  type ReplyRateTrack,
} from '../lib/reply-rate';

/**
 * Estimated tok/s of the reply a run is writing, refreshed once a second;
 * `null` while it does anything else or the reading is in doubt. It follows
 * the text outside React, so the text's every frame re-renders nothing but
 * this value, and that at most once a second.
 */
export function useReplyRate(
  groupJid: string,
  agentId?: string,
): number | null {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    setRate(null);
    let track: ReplyRateTrack | null = null;
    const observe = (state: ReturnType<typeof useChatStore.getState>) => {
      const streaming = agentId
        ? state.agentStreaming[agentId]
        : state.streaming[groupJid];
      if (isWritingReply(streaming)) {
        track = trackReplyText(
          track,
          streaming.partialText,
          streaming.partialBase ?? 0,
          Date.now(),
        );
      } else if (track) {
        // Shown no longer, measured afresh once the text streams again.
        track = null;
        setRate(null);
      }
    };
    observe(useChatStore.getState());
    const unsubscribe = useChatStore.subscribe(observe);
    const timer = window.setInterval(() => {
      const value = replyRate(track, Date.now());
      setRate(value == null ? null : Math.round(value));
    }, 1000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [groupJid, agentId]);
  return rate;
}
