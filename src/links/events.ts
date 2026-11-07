// Zdarzenie link.opened: pierwsze wejście odbiorcy w dany krótki link, z pominięciem automatów.
// Trafia do webhooka klucza, którym wysłano link, i do jego integracji wychodzących z tym zdarzeniem.
import type { CampaignRow } from '../store/campaigns.ts';
import type { LinkDomainRow } from '../store/link-domains.ts';
import type { ShortLinkRow } from '../store/short-links.ts';
import { emitIntegrations, type IntegrationEmitDeps } from '../worker/integrations.ts';
import { emitWebhook, type WebhookEmitDeps } from '../worker/webhook.ts';
import { shortUrl } from './shortener.ts';

export type LinkOpenedDeps = WebhookEmitDeps & { integrationEmit?: IntegrationEmitDeps };

/**
 * Odbiorca rozsyłki nie jest wiadomością: dla niego `messageId` ma wartość null, a odbiorcę wskazują
 * `packageId`, `seq` i `clientId`. Krótki link zawsze ze schematem, niezależnie od zapisu w treści SMS-a.
 */
export function emitLinkOpened(deps: LinkOpenedDeps, link: ShortLinkRow, campaign: CampaignRow, domain: LinkDomainRow, now: Date): void {
  const payload = {
    messageId: link.messageId, packageId: link.packageId, seq: link.seq, campaign: campaign.name,
    to: link.dest, clientId: link.clientId, target: link.target, shortUrl: shortUrl(domain.domain, link.code, false),
    openedAt: now.toISOString(),
  };
  // Dostawa zawiera dane odbiorcy, dlatego traci je w terminie retencji kodu (spec 10).
  emitWebhook(deps, link.apiKeyId, 'link.opened', payload, now, { purgeAfter: link.purgeAfter });
  if (deps.integrationEmit) {
    emitIntegrations(deps.integrationEmit, link.apiKeyId, 'link.opened', payload, now, {
      purgeAfter: link.purgeAfter, ...(link.messageId === null ? {} : { messageId: link.messageId }),
    });
  }
}
