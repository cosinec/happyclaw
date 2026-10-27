import type { StepQuestion } from '../../lib/stream-steps';
import { useShellStore } from '../../stores/shell';

/**
 * AskUserQuestion options. The runner has no interactive answer channel, so
 * the reply is the user's next message: an option click fills the composer.
 */
export function AskUserQuestionCard({
  questions,
}: {
  questions: readonly StepQuestion[];
}) {
  if (questions.length === 0) return null;

  return (
    <div className="mt-2 mb-2 space-y-2">
      {questions.map((q, qi) => (
        <div
          key={qi}
          className="rounded-lg bg-surface-raised p-3 font-sans ring-1 ring-surface-border"
        >
          <div className="mb-2 text-body font-medium text-foreground">
            {q.question}
          </div>
          {q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((label, oi) => (
                <button
                  key={oi}
                  type="button"
                  onClick={() =>
                    useShellStore.getState().requestComposerDraft(label)
                  }
                  className="inline-flex h-7 cursor-pointer items-center rounded-md bg-muted px-2.5 text-caption font-medium text-foreground ring-1 ring-surface-border transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:h-10"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="mt-2 text-caption text-muted-foreground">
            点选项填入输入框，或直接输入回复后发送
          </div>
        </div>
      ))}
    </div>
  );
}
