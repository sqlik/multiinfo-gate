import { describe, expect, it } from 'vitest';
import { defaultOutboundConfig, type OutboundConfig } from '../../src/integrations/config.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { handleClick } from '../../src/links/clicks.ts';
import { emitLinkOpened, type LinkOpenedDeps } from '../../src/links/events.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { WebhookDeliveriesRepo } from '../../src/store/webhook-deliveries.ts';
import { messageInput } from '../store/helpers.ts';
import { CAMPAIGN, NOW, redirectFixture } from './redirect-fixture.ts';

const LATER = new Date(NOW.getTime() + 3_600_000);

const setup = () => {
  const f = redirectFixture();
  f.apiKeys.setWebhook(f.apiKeyId, 'https://crm.firma.pl/sms/zdarzenia', 'sekret-webhooka');
  // Dziennik integracji wskazuje wiadomość kluczem obcym - wiadomość musi istnieć.
  f.messages.insert(messageInput({ id: 'msg_1', apiKeyId: f.apiKeyId, accountId: f.accountId }));
  const integrations = new IntegrationsRepo(f.db, f.key);
  const deliveries = new WebhookDeliveriesRepo(f.db, f.key);
  const jobs = new JobsRepo(f.db);
  const deps: LinkOpenedDeps = {
    apiKeys: f.apiKeys, deliveries, jobs,
    integrationEmit: {
      integrations, integrationEvents: new IntegrationEventsRepo(f.db, f.key), guards: new IntegrationGuardsRepo(f.db),
      deliveries, jobs, engine: new TemplateEngine(),
    },
  };
  const clickDeps = { ...f.deps, opened: (...args: Parameters<typeof emitLinkOpened> extends [unknown, ...infer R] ? R : never) => emitLinkOpened(deps, ...args) };
  const click = (code: string, automated = false) => handleClick(clickDeps, 'l.firma.pl', code, automated, LATER);
  const outbound = (name: string, config: Partial<OutboundConfig>) => integrations.insert({
    name, kind: 'webhook_out', apiKeyId: f.apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
    config: { ...defaultOutboundConfig(), url: 'https://hooks.firma.pl/kampanie', body: { mode: 'json', template: '{"kto": {{ to | json }}, "cel": {{ target | json }}}' }, ...config },
    secrets: {}, storePayloads: 0, createdAt: NOW,
  });
  const keyDeliveries = () => deliveries.listRecent(20).filter((d) => d.integrationId === null);
  return { ...f, deps, deliveries, jobs, integrations, click, outbound, keyDeliveries };
};

describe('emitLinkOpened', () => {
  it('pierwsze otwarcie linku z wiadomości tworzy dostawę webhooka klucza z polami ładunku', () => {
    const s = setup();
    const code = s.addLink();
    s.click(code);
    const sent = s.keyDeliveries();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toBe('link.opened');
    expect(sent[0]!.url).toBe('https://crm.firma.pl/sms/zdarzenia');
    expect(JSON.parse(sent[0]!.payload)).toEqual({
      event: 'link.opened', at: LATER.toISOString(), messageId: 'msg_1', packageId: null, seq: null, campaign: CAMPAIGN,
      to: '48601000001', clientId: null, target: 'https://firma.pl/przeglad', shortUrl: `https://l.firma.pl/${code}`,
      openedAt: LATER.toISOString(),
    });
    expect(s.jobs.depth()).toBe(1);
  });

  it('dostawy zdarzenia otrzymują termin retencji kodu, po którym tracą dane odbiorcy', () => {
    const s = setup();
    s.outbound('CRM kampanie', { events: ['link.opened'] });
    const code = s.addLink({ purgeAfter: '2027-03-05T10:00:00.000Z' });
    s.click(code);
    const rows = s.deliveries.listRecent(10);
    expect(rows).toHaveLength(2);
    expect(s.deliveries.purgeDetails(new Date('2027-03-05T09:59:59Z'))).toBe(0);
    expect(s.deliveries.purgeDetails(new Date('2027-03-05T10:00:01Z'))).toBe(2);
    const payloads = s.deliveries.listRecent(10).map((d) => d.payload).join(' ');
    expect(payloads).not.toMatch(/48601000001|firma\.pl\/przeglad/);
  });

  it('odbiorca rozsyłki ma messageId null oraz identyfikator rozsyłki i numer kolejny', () => {
    const s = setup();
    const code = s.addLink({ recipientKey: 'pkg_7:3', messageId: null, packageId: 'pkg_7', seq: 3, dest: '48601000003', clientId: 'K-1042' });
    s.click(code);
    expect(JSON.parse(s.keyDeliveries()[0]!.payload)).toMatchObject({
      messageId: null, packageId: 'pkg_7', seq: 3, to: '48601000003', clientId: 'K-1042',
    });
  });

  it('integracja wychodząca z link.opened otrzymuje dostawę, integracja bez tego zdarzenia nie', () => {
    const s = setup();
    const subscribed = s.outbound('CRM kampanii', { events: ['link.opened'] });
    const other = s.outbound('Doręczenia', { events: ['message.delivered'] });
    s.click(s.addLink());
    const all = s.deliveries.listRecent(20);
    const integration = all.filter((d) => d.integrationId !== null);
    expect(integration).toHaveLength(1);
    expect(integration[0]!.integrationId).toBe(subscribed);
    expect(JSON.parse(integration[0]!.payload)).toEqual({ kto: '48601000001', cel: 'https://firma.pl/przeglad' });
    expect(all.some((d) => d.integrationId === other)).toBe(false);
  });

  it('drugi klik tego samego odbiorcy i wejście automatu nie tworzą dostawy', () => {
    const s = setup();
    s.outbound('CRM kampanii', { events: ['link.opened'] });
    const code = s.addLink();
    const bot = s.addLink({ code: 'botKod1' });
    s.click(bot, true);
    expect(s.deliveries.listRecent(20)).toHaveLength(0);
    s.click(code);
    s.click(code);
    expect(s.deliveries.listRecent(20)).toHaveLength(2);
  });

  it('klucz bez adresu webhooka nie otrzymuje dostawy, integracje działają dalej', () => {
    const s = setup();
    s.apiKeys.setWebhook(s.apiKeyId, null, null);
    s.outbound('CRM kampanii', { events: ['link.opened'] });
    s.click(s.addLink());
    expect(s.keyDeliveries()).toHaveLength(0);
    expect(s.deliveries.listRecent(20)).toHaveLength(1);
  });
});
