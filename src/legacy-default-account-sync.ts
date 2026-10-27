import {
  loadChannelAccountSecret,
  type ChannelAccountSecret,
} from './channel-account-secrets.js';
import { syncDefaultChannelAccountCredentials } from './channel-account-migration.js';
import { getLegacyChannelAccount } from './db.js';
import { normalizeFeishuBrand } from './feishu-domain.js';
import type { ChannelAccount } from './types.js';

/** The legacy user-level Feishu settings the default account mirrors. */
export interface LegacyFeishuAccountConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  ownerOpenId?: string;
  /** Feishu or Lark; a config written before brands existed has none. */
  domain?: unknown;
}

/**
 * Rebuild the legacy default Feishu account from the user-level settings.
 * The secret is replaced wholesale, so the brand is carried explicitly: the
 * config's own `domain` wins, otherwise the account keeps the brand it already
 * had. A legacy save must never turn a Lark account back into Feishu.
 */
export function syncLegacyFeishuDefaultAccount(
  userId: string,
  config: LegacyFeishuAccountConfig,
): ChannelAccount {
  const legacy = getLegacyChannelAccount(userId, 'feishu');
  const domain =
    config.domain ??
    (legacy ? loadChannelAccountSecret(legacy.secret_ref)?.domain : undefined);
  const secret: ChannelAccountSecret = {
    appId: config.appId,
    appSecret: config.appSecret,
    ownerOpenId: config.ownerOpenId,
  };
  if (domain !== undefined) secret.domain = normalizeFeishuBrand(domain);
  return syncDefaultChannelAccountCredentials({
    ownerUserId: userId,
    provider: 'feishu',
    name: '默认飞书',
    enabled: config.enabled !== false,
    secret,
  });
}
