/**
 * Group response audience for IM channels.
 *
 * `isSenderAdmittedByGroupPolicy` is the host policy for a registered chat;
 * `isGroupSenderAdmitted` is where the non-Feishu connectors ask the host
 * and which single message may bypass it. Feishu runs its own connector gate
 * because it also learns the account owner from the first DM.
 */
import {
  effectiveAudienceMode,
  isSenderAllowedByAudience,
} from './im-audience-policy.js';
import type { RegisteredGroup } from './types.js';

/** The registered-group fields the owner bootstrap needs. */
export interface GroupOwnerView {
  owner_im_id?: string;
  owner_claim_source?: string;
}

/**
 * A structured provider mention, normalized by the connector. `imId` is in
 * the same namespace the connector passes as `senderImId` (and therefore as
 * `owner_im_id` and allowlist entries); `id.open_id` is the Feishu shape.
 */
export interface ChannelCommandMention {
  key?: string;
  name?: string;
  imId?: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
}

/** The mentioned member's id, in the namespace of this channel's senders. */
export function mentionImId(
  mention: ChannelCommandMention,
): string | undefined {
  return mention.imId ?? mention.id?.open_id;
}

/**
 * Host admission policy of a registered chat. An owner-only audience admits
 * exactly the recorded owner (fail closed while it is unknown). Otherwise a
 * non-Feishu chat still honors its legacy multi-member allowlist, filled by
 * `/allow` and `/disallow`; Feishu treats the two-state audience as the only
 * source of truth since v58.
 */
export function isSenderAdmittedByGroupPolicy(
  group: Pick<
    RegisteredGroup,
    'audience_mode' | 'activation_mode' | 'owner_im_id' | 'sender_allowlist'
  >,
  senderImId: string | undefined,
  channelType: string | null,
): boolean {
  if (effectiveAudienceMode(group) === 'owner_only') {
    return isSenderAllowedByAudience(group, senderImId);
  }
  if (channelType === 'feishu') return true;
  const allowlist = group.sender_allowlist;
  if (allowlist === undefined || allowlist === null) return true;
  return !!senderImId && allowlist.includes(senderImId);
}

/**
 * `/owner_mention` in a group that has no owner yet, and was not quarantined
 * by a credential transfer, is the only way an owner-only group gets its first
 * owner from IM. It must pass the audience gate, which rejects everyone while
 * the owner is unknown; `handleCommand` still decides the claim itself.
 */
export function isOwnerBootstrapCommand(
  commandText: string,
  group: GroupOwnerView | undefined,
): boolean {
  const name = commandText
    .trim()
    .match(/^\/([^\s@]+)/)?.[1]
    ?.toLowerCase();
  return (
    name === 'owner_mention' &&
    !!group &&
    !group.owner_im_id &&
    group.owner_claim_source !== 'transfer_reset'
  );
}

/**
 * Whether a message in a group chat may reach commands, the Agent or any
 * side effect. Call it only for group chats, after pairing/authorization and
 * before commands, mention gates, registration and downloads. A connector
 * without the host callback admits everyone (unchanged legacy behavior).
 */
export function isGroupSenderAdmitted(input: {
  chatJid: string;
  senderImId?: string;
  /** Message text after removing a leading structured bot mention. */
  commandText: string;
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  resolveRegisteredGroup?: (jid: string) => GroupOwnerView | undefined;
}): boolean {
  if (!input.isSenderAllowedInGroup) return true;
  if (input.isSenderAllowedInGroup(input.chatJid, input.senderImId)) {
    return true;
  }
  return isOwnerBootstrapCommand(
    input.commandText,
    input.resolveRegisteredGroup?.(input.chatJid),
  );
}
