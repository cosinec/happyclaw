import type { ReactNode } from 'react';
import {
  Eraser,
  FileUp,
  FolderUp,
  Image as ImageIcon,
  Loader2,
  Plus,
  TerminalSquare,
} from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { IconButton } from '../../common/IconButton';
import { Shortcut } from '../../common/Shortcut';
import { SendButton, type SendButtonGlyph } from './cindy/SendButton';

/**
 * Composer toolbar pill (cindy's dropdown tier): bare at rest, an outline and
 * hover fill on hover or while its menu is open.
 */
const COMPOSER_PILL =
  'size-[30px] shrink-0 rounded-full border border-transparent text-muted-foreground hover:border-surface-border hover:bg-surface-hover hover:text-foreground data-[state=open]:border-surface-border data-[state=open]:bg-surface-hover pointer-coarse:size-10';

interface ComposerToolbarProps {
  canAttach: boolean;
  uploading: boolean;
  onPickImages: () => void;
  onPickFiles: () => void;
  onPickFolder: () => void;
  onResetSession?: () => void;
  onToggleTerminal?: () => void;
  modelSelector?: ReactNode;
  contextLabel?: string;
  /** A stop control beside the primary action (a draft holds that spot). */
  showSideStop: boolean;
  stopping: boolean;
  stopDisabled: boolean;
  onStop: () => void;
  send: {
    glyph: SendButtonGlyph;
    disabled: boolean;
    label: string;
    onClick: () => void;
    /** Escape stops; the alternate follow-up mode and its shortcut. */
    escapeStops: boolean;
    alternate?: { label: string; shortcut: string };
  };
}

/**
 * cindy's toolbar: attach, reset and terminal on the left; the model, stop
 * and send on the right. The model trigger gives way first, so a narrow row
 * truncates it and never squeezes the send button.
 */
export function ComposerToolbar({
  canAttach,
  uploading,
  onPickImages,
  onPickFiles,
  onPickFolder,
  onResetSession,
  onToggleTerminal,
  modelSelector,
  contextLabel,
  showSideStop,
  stopping,
  stopDisabled,
  onStop,
  send,
}: ComposerToolbarProps) {
  return (
    <div
      data-composer-toolbar
      className="mt-[2px] flex min-w-0 items-center gap-1 select-none"
    >
      <div className="flex min-w-0 items-center gap-1">
        {canAttach && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                label="添加文件"
                icon={<Plus />}
                disabled={uploading}
                tooltipSide="top"
                className={COMPOSER_PILL}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-44">
              <DropdownMenuItem onClick={onPickImages}>
                <ImageIcon />
                添加图片
              </DropdownMenuItem>
              <DropdownMenuItem disabled={uploading} onClick={onPickFiles}>
                <FileUp />
                上传文件
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={uploading}
                className="max-lg:hidden"
                onClick={onPickFolder}
              >
                <FolderUp />
                上传文件夹
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {onResetSession && (
          <IconButton
            label="清除当前会话上下文"
            icon={<Eraser />}
            onClick={onResetSession}
            tooltipSide="top"
            className={COMPOSER_PILL}
          />
        )}
        {onToggleTerminal && (
          <IconButton
            label="终端"
            icon={<TerminalSquare />}
            onClick={onToggleTerminal}
            tooltipSide="top"
            className={COMPOSER_PILL}
          />
        )}
        {contextLabel && (
          <span
            className="ml-1 inline-flex h-6 max-w-[min(42vw,180px)] min-w-0 items-center rounded-full bg-muted px-2 text-micro font-medium text-muted-foreground"
            title={`发送到：${contextLabel}`}
          >
            <span className="truncate">{contextLabel}</span>
          </span>
        )}
      </div>

      <div className="flex-1" />

      {modelSelector && (
        // The padding keeps the triggers' focus rings inside the clip.
        <div
          data-composer-model-slot
          className="-m-0.5 flex min-w-0 items-center justify-end gap-1 overflow-hidden p-0.5"
        >
          {modelSelector}
        </div>
      )}

      {showSideStop && (
        <IconButton
          label="停止当前运行"
          icon={
            stopping ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <span className="block size-2.5 rounded-[1.5px] bg-current" />
            )
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={onStop}
          disabled={stopDisabled}
          tooltipSide="top"
          className={COMPOSER_PILL}
        />
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <SendButton
            glyph={send.glyph}
            disabled={send.disabled}
            onClick={send.onClick}
            ariaLabel={send.label}
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="flex-col items-start">
          <span className="flex items-center gap-1.5">
            {send.label}
            {send.escapeStops && <Shortcut keys="escape" />}
          </span>
          {send.alternate && (
            <span className="flex items-center gap-1.5 opacity-70">
              {send.alternate.label}
              <Shortcut keys={send.alternate.shortcut} />
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
