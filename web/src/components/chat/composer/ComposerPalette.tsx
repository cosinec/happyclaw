import { useEffect, useId, useRef } from 'react';
import { File, Folder, Loader2, Sparkles, SquareSlash } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ComposerPaletteState, PaletteItem } from './useComposerPalette';

const ICONS: Record<PaletteItem['kind'], typeof File> = {
  command: SquareSlash,
  skill: Sparkles,
  file: File,
  dir: Folder,
};

/**
 * The `/` and `@` list above the composer card (cindy's 12px panel). Focus
 * stays in the editor: the editor's keys drive the highlight, and rows keep
 * the caret on mouse down.
 */
export function ComposerPalette({
  palette,
  touch,
}: {
  palette: ComposerPaletteState;
  touch: boolean;
}) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const { items, activeIndex, status, kind } = palette;

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, items]);

  const emptyText =
    status === 'loading'
      ? '正在加载…'
      : status === 'error'
        ? kind === 'slash'
          ? '技能列表加载失败'
          : '无法读取工作区文件'
        : kind === 'slash'
          ? '没有匹配的命令或技能'
          : '没有匹配的文件';

  return (
    <div
      data-composer-palette={kind}
      className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-[12px] border border-surface-border bg-popover text-popover-foreground shadow-menu"
    >
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={kind === 'slash' ? '命令与技能' : '工作区文件'}
        className="max-h-64 overflow-y-auto overscroll-contain p-1"
      >
        {items.map((item, index) => {
          const Icon = ICONS[item.kind];
          const active = index === activeIndex;
          return (
            <div
              key={item.key}
              role="option"
              aria-selected={active}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => !active && palette.setActiveIndex(index)}
              onClick={() => palette.pick(index)}
              className={cn(
                'flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-body',
                touch && 'min-h-10',
                active && 'bg-surface-hover',
              )}
            >
              <Icon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="shrink-0 truncate font-medium">
                {item.label}
              </span>
              {item.detail ? (
                <span className="min-w-0 truncate text-caption text-muted-foreground">
                  {item.detail}
                </span>
              ) : null}
            </div>
          );
        })}
        {items.length === 0 || status === 'loading' ? (
          <div className="flex h-8 items-center gap-2 px-2 text-caption text-muted-foreground">
            {status === 'loading' ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : null}
            {items.length === 0 ? emptyText : '正在加载…'}
          </div>
        ) : null}
      </div>
      {!touch && (
        <div className="border-t border-surface-border px-3 py-1.5 text-micro text-faint-foreground">
          {kind === 'slash'
            ? '↑↓ 选择 · Enter 插入 · Esc 关闭'
            : '↑↓ 选择 · Enter 插入 · Tab 进入目录 · Esc 关闭'}
        </div>
      )}
    </div>
  );
}
