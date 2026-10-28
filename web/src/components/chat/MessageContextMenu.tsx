import { Fragment, type ReactNode } from 'react';
import { Copy, FileText, ImageDown, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useChatStore } from '../../stores/chat';
import { confirmDialog } from '../../stores/confirm';
import { mediumTap } from '../../hooks/useHaptic';
import { copyToClipboard } from '../../utils/clipboard';
import { markdownToPlainText } from '../../lib/markdown-plain-text';
import { toast } from 'sonner';
import type { NativeMenuAction } from '../../native/context-menu';

function copyWithFeedback(text: string) {
  copyToClipboard(text).then(
    () => toast.success('已复制'),
    () => toast.error('复制失败，请手动选择文本复制'),
  );
}

interface MessageMenuTarget {
  content: string;
  chatJid?: string;
  messageId?: string;
  onShareImage?: () => void;
}

interface MessageMenuAction extends NativeMenuAction {
  icon: ReactNode;
}

async function deleteMessageRecord(chatJid: string, messageId: string) {
  const confirmed = await confirmDialog({
    title: '删除聊天记录',
    message: '仅删除持久聊天记录，不会撤回正在处理的模型输入。',
    confirmText: '确认删除记录',
    variant: 'danger',
  });
  if (confirmed) {
    await useChatStore.getState().deleteMessage(chatJid, messageId);
  }
}

/**
 * Per-message actions: copy as text / Markdown, share image, delete record.
 * The dropdown below and the iOS shell's long-press menu render this same
 * list, so both always offer the same actions.
 */
export function messageMenuActions({
  content,
  chatJid,
  messageId,
  onShareImage,
}: MessageMenuTarget): MessageMenuAction[] {
  const actions: MessageMenuAction[] = [];
  if (content.trim()) {
    actions.push(
      {
        id: 'copy-text',
        title: '复制文本',
        symbol: 'doc.on.doc',
        icon: <Copy />,
        onSelect: () => copyWithFeedback(markdownToPlainText(content)),
      },
      {
        id: 'copy-markdown',
        title: '复制 Markdown',
        symbol: 'doc.plaintext',
        icon: <FileText />,
        onSelect: () => copyWithFeedback(content),
      },
    );
  }
  if (onShareImage) {
    actions.push({
      id: 'share-image',
      title: '生成分享图片',
      symbol: 'photo.on.rectangle',
      icon: <ImageDown />,
      onSelect: onShareImage,
    });
  }
  if (chatJid && messageId) {
    actions.push({
      id: 'delete',
      title: '删除聊天记录',
      symbol: 'trash',
      icon: <Trash2 />,
      destructive: true,
      onSelect: () => void deleteMessageRecord(chatJid, messageId),
    });
  }
  return actions;
}

interface MessageContextMenuProps extends MessageMenuTarget {
  align?: 'start' | 'end';
  /** The trigger button (rendered via asChild). */
  children: ReactNode;
}

/** The message 「…」 dropdown. */
export function MessageContextMenu({
  align = 'start',
  children,
  ...target
}: MessageContextMenuProps) {
  const actions = messageMenuActions(target);
  return (
    <DropdownMenu onOpenChange={(open) => open && mediumTap()}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44">
        {actions.map((action, index) => (
          <Fragment key={action.id}>
            {action.destructive && index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              variant={action.destructive ? 'destructive' : 'default'}
              onClick={action.onSelect}
            >
              {action.icon}
              {action.title}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
