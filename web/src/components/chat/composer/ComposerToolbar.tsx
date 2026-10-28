import type { ReactNode } from 'react';
import {
  FileUp,
  FolderUp,
  Image as ImageIcon,
  Loader2,
  Paintbrush,
  Plus,
  TerminalSquare,
} from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  /** A narrow row: reset and terminal move into the + menu. */
  foldActions?: boolean;
  modelSelector?: ReactNode;
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
 * truncates it and never squeezes the tools or the send button. Below 480px
 * reset and terminal fold into the + menu, leaving the model more room.
 */
export function ComposerToolbar({
  canAttach,
  uploading,
  onPickImages,
  onPickFiles,
  onPickFolder,
  onResetSession,
  onToggleTerminal,
  foldActions = false,
  modelSelector,
  showSideStop,
  stopping,
  stopDisabled,
  onStop,
  send,
}: ComposerToolbarProps) {
  const menuReset = foldActions && !!onResetSession;
  const menuTerminal = foldActions && !!onToggleTerminal;
  return (
    <div
      data-composer-toolbar
      className="mt-[2px] flex min-w-0 items-center gap-1 select-none"
    >
      {/* Fixed buttons: only the model slot gives way. */}
      <div data-composer-tools className="flex shrink-0 items-center gap-1">
        {(canAttach || menuReset || menuTerminal) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                // Named after what the menu offers.
                label={menuReset || menuTerminal ? '更多操作' : '添加文件'}
                icon={<Plus />}
                disabled={uploading && !menuReset && !menuTerminal}
                tooltipSide="top"
                className={COMPOSER_PILL}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-44">
              {canAttach && (
                <>
                  {/* Images go inline with the message, not through the
                      upload channel, so an upload in progress allows them. */}
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
                </>
              )}
              {canAttach && (menuReset || menuTerminal) && (
                <DropdownMenuSeparator />
              )}
              {menuReset && (
                <DropdownMenuItem onClick={onResetSession}>
                  <Paintbrush />
                  清除上下文
                </DropdownMenuItem>
              )}
              {menuTerminal && (
                <DropdownMenuItem onClick={onToggleTerminal}>
                  <TerminalSquare />
                  终端
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {onResetSession && !foldActions && (
          <IconButton
            label="清除当前会话上下文"
            icon={<Paintbrush />}
            onClick={onResetSession}
            tooltipSide="top"
            className={COMPOSER_PILL}
          />
        )}
        {onToggleTerminal && !foldActions && (
          <IconButton
            label="终端"
            icon={<TerminalSquare />}
            onClick={onToggleTerminal}
            tooltipSide="top"
            className={COMPOSER_PILL}
          />
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
