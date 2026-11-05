import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultInboundConfig, defaultMailInConfig, defaultPowerAutomateConfig, defaultSmsGroupConfig,
  type InboundConfig, type MailInConfig, type PowerAutomateConfig, type SmsGroupConfig,
} from '../../src/integrations/config.ts';
import type { ParsedMail } from '../../src/integrations/mail/parse.ts';
import {
  previewInbound, previewMailIn, previewSmsGroup, runInbound, runMailIn, runSmsGroup,
  type InboundIntegration, type MailInIntegration, type ReceivedEvent, type SmsGroupIntegration,
} from '../../src/integrations/pipeline.ts';
import { runPowerAutomate, type PaCall, type PowerAutomateIntegration } from '../../src/integrations/power-automate.ts';
import { prepareLinks } from '../../src/links/shortener.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo, type LinkMode } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import type { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-11-05T10:00:00Z');
const SHORT = /https:\/\/(?:l\.firma\.pl|firma-link\.pl)\/([A-Za-z0-9]{7})/g;
const ip = { sourceIp: '203.0.113.1' };

let deps: Parameters<typeof runPowerAutomate>[0];
let integrations: IntegrationsRepo;
let apiKeys: ApiKeysRepo;
let packages: PackagesRepo;
let apiKeyId: number;
let domainId: number;
let otherDomainId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accounts = new AccountsRepo(db, key);
  const accountId = accounts.insert(accountInput({ storeContent: 1 }));
  apiKeys = new ApiKeysRepo(db, key);
  apiKeyId = apiKeys.insert({
    accountId, name: 'Serwis klimatyzacji', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  const extra = integrationDeps(db, key);
  domainId = extra.linkDomains.create({ domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, NOW);
  otherDomainId = extra.linkDomains.create({ domain: 'firma-link.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, NOW);
  integrations = extra.integrations;
  packages = new PackagesRepo(db);
  deps = {
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
    inbound: new InboundMessagesRepo(db), packages, ...extra,
  };
  linkMode('sender');
});

function linkMode(mode: LinkMode): void {
  apiKeys.setLinkSettings(apiKeyId, {
    mode, domainIds: [domainId, otherDomainId], defaultDomainId: domainId, targets: ['firma.pl'], validityDays: 90, utm: true,
  });
}

const codesIn = (text: string) => [...text.matchAll(SHORT)].map((m) => m[1]!);
const body = (id: string) => deps.messages.get(id)!.body!;
const campaignOf = (id: string) => {
  const campaignId = deps.messages.get(id)!.campaignId;
  return campaignId === null ? undefined : deps.campaigns.get(campaignId);
};
const allCampaigns = () => deps.campaigns.list({ offset: 0, limit: 10 }).rows;
const shorten = (text: string) => prepareLinks(deps, apiKeyId, text, {}, {});

const inbound = (config: Partial<InboundConfig> = {}): InboundIntegration => {
  const id = integrations.insert({
    name: 'Zgłoszenia serwisowe', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
    config: { ...defaultInboundConfig(), text: { mode: 'liquid', template: '{{ p.msg }}' }, to: { path: 'to', fallback: [] }, ...config },
    secrets: {}, storePayloads: 0, createdAt: NOW,
  });
  return integrations.get(id) as InboundIntegration;
};

describe('integracja przychodząca z krótkimi linkami', () => {
  it('skraca link w SMS-ie i zakłada kampanię o nazwie integracji', async () => {
    const out = await runInbound(deps, inbound(), { to: '48601000001', msg: 'Przegląd klimatyzacji: https://firma.pl/folder.pdf' }, ip, NOW);
    expect(out.kind).toBe('sent');
    const id = (out as { messageIds: string[] }).messageIds[0]!;
    expect(body(id)).toMatch(/^Przegląd klimatyzacji: https:\/\/l\.firma\.pl\/[A-Za-z0-9]{7}$/);
    expect(body(id)).not.toContain('0000000');
    expect(deps.shortLinks.forMessage(id)).toMatchObject([{ code: codesIn(body(id))[0], target: 'https://firma.pl/folder.pdf' }]);
    expect(campaignOf(id)).toMatchObject({ name: 'Zgłoszenia serwisowe', sent: 1 });
  });

  it('tryb „przytnij” usuwa w całości link przecięty na granicy limitu i nie zapisuje kodu', async () => {
    // Szablon: 141 znaków i krótki link z 26 znakami - przycięcie do 160 znaków wypada w środku linku.
    const integ = inbound({ maxParts: 1, overflow: 'truncate' });
    const out = await runInbound(deps, integ, { to: '48601000001', msg: `${'x'.repeat(140)} https://firma.pl/folder.pdf` }, ip, NOW);
    expect(out.kind).toBe('sent');
    const id = (out as { messageIds: string[] }).messageIds[0]!;
    expect(body(id)).toBe(`${'x'.repeat(140)} ...`);
    expect(deps.shortLinks.forMessage(id)).toEqual([]);
    expect(deps.messages.get(id)!.campaignId).toBeNull();
    expect(allCampaigns()).toEqual([]);
  });

  it('tryb „odrzuć” liczy części po skróceniu: długi link mieści się w jednej części dopiero po skróceniu', async () => {
    const msg = `${'x'.repeat(120)} https://firma.pl/oferta/${'a'.repeat(60)}`;
    const integ = inbound({ maxParts: 1, overflow: 'reject' });
    const out = await runInbound(deps, integ, { to: '48601000001', msg }, ip, NOW);
    expect(out.kind).toBe('sent');
    expect(deps.messages.get((out as { messageIds: string[] }).messageIds[0]!)!.parts).toBe(1);

    linkMode('off');
    expect(await runInbound(deps, integ, { to: '48601000001', msg }, ip, NOW)).toMatchObject({ kind: 'error', code: 'too_many_parts' });
  });

  it('podgląd „Sprawdź szablon” pokazuje szablon z kodem zastępczym i liczy jego części bez zapisu kodów', () => {
    const p = previewInbound(deps.engine, inbound().config, { to: '48601000001', msg: 'Przegląd klimatyzacji: https://firma.pl/folder.pdf' }, '48', NOW, undefined, shorten);
    expect(p).toMatchObject({ text: 'Przegląd klimatyzacji: https://l.firma.pl/0000000', parts: 1, error: null });
    expect(allCampaigns()).toEqual([]);
  });
});

describe('Mail2SMS z krótkimi linkami', () => {
  const mailIn = (config: Partial<MailInConfig> = {}): MailInIntegration => {
    const id = integrations.insert({
      name: 'Zlecenia z poczty', kind: 'mail_in', apiKeyId, serviceId: null, orig: null, preset: 'poczta-wlasny', enabled: 1,
      config: { ...defaultMailInConfig(), senders: [{ pattern: '@firma.pl', recipients: [] }], to: { fallback: ['48601000009'] }, ...config },
      secrets: { imap_password: 'x' }, storePayloads: 0, createdAt: NOW,
    });
    return integrations.get(id) as MailInIntegration;
  };
  const mail = (over: Partial<ParsedMail> = {}): ParsedMail => ({
    from: 'dyspozytor@firma.pl', fromName: 'Dyspozytor', subject: 'Zlecenie 12/11', textFull: 'Protokół: https://firma.pl/protokol/12', date: NOW.toISOString(),
    to: ['bramka@firma.pl'], messageId: '<z12@firma.pl>', authResults: [], exchangeAuthAs: null, auto: false, ...over,
  });

  it('skraca link z treści maila przy kluczu w trybie „Zawsze”', async () => {
    linkMode('always');
    const out = await runMailIn(deps, mailIn(), mail(), NOW);
    expect(out.kind).toBe('sent');
    const id = (out as { messageIds: string[] }).messageIds[0]!;
    expect(body(id)).toMatch(/Protokół: https:\/\/l\.firma\.pl\/[A-Za-z0-9]{7}$/);
    expect(body(id)).not.toContain('firma.pl/protokol');
    expect(campaignOf(id)).toMatchObject({ name: 'Zlecenia z poczty' });
    // Raport do nadawcy maila pokazuje szablon: kod każdego odbiorcy jest inny, a kliknięcie
    // w raporcie nie może liczyć się jako otwarcie przez odbiorcę.
    expect((out as { text: string }).text).toContain('https://l.firma.pl/0000000');
  });

  it('podgląd skrzynki pokazuje szablon z kodem zastępczym', () => {
    const p = previewMailIn(deps.engine, mailIn().config, mail(), '48', NOW, shorten);
    expect(p.text).toContain('Protokół: https://l.firma.pl/0000000');
    expect(allCampaigns()).toEqual([]);
  });
});

describe('SMS do grupy z krótkimi linkami', () => {
  const group = (config: Partial<SmsGroupConfig> = {}): SmsGroupIntegration => {
    const id = integrations.insert({
      name: 'Ekipa serwisowa', kind: 'sms_group', apiKeyId, serviceId: null, orig: null, preset: 'sms-grupa', enabled: 1,
      config: {
        ...defaultSmsGroupConfig(), senders: [{ phone: '48601000001', name: 'Ania' }], recipients: ['48601000002', '48601000003'], prefix: 'serwis', ...config,
      },
      secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    return integrations.get(id) as SmsGroupIntegration;
  };
  const event = (text: string): ReceivedEvent => ({
    id: 'in_1', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text, receivedAt: NOW.toISOString(), relatedMessageId: null,
  });

  it('każdy odbiorca grupy otrzymuje własny kod w jednej kampanii o nazwie integracji', () => {
    const out = runSmsGroup(deps, group(), event('Serwis: instrukcja https://firma.pl/instrukcja.pdf'), NOW);
    expect(out.kind).toBe('sent');
    const ids = (out as { messageIds: string[] }).messageIds;
    const codes = ids.flatMap((id) => codesIn(body(id)));
    expect(codes).toHaveLength(2);
    expect(new Set(codes).size).toBe(2);
    expect(campaignOf(ids[0]!)).toMatchObject({ name: 'Ekipa serwisowa', sent: 2 });
    expect(allCampaigns()).toHaveLength(1);
  });

  it('podgląd grupy pokazuje szablon z kodem zastępczym', () => {
    const p = previewSmsGroup(deps.engine, group().config, event('Serwis: instrukcja https://firma.pl/instrukcja.pdf'), NOW, shorten);
    expect(p.text).toBe('instrukcja https://l.firma.pl/0000000');
    expect(allCampaigns()).toEqual([]);
  });
});

describe('Power Automate z krótkimi linkami', () => {
  const pa = (config: Partial<PowerAutomateConfig> = {}): PowerAutomateIntegration => {
    const id = integrations.insert({
      name: 'Dyspozytornia', kind: 'power_automate', apiKeyId, serviceId: null, orig: null, preset: 'power-automate', enabled: 1,
      config: { ...defaultPowerAutomateConfig(), recipients: [{ phone: '48601000011', name: 'Marek' }, { phone: '48601000012', name: 'Ola' }], ...config },
      secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    return integrations.get(id) as PowerAutomateIntegration;
  };
  const meta = { sourceIp: 'API · 127.0.0.1' };
  const sms = (text: string, extra: Record<string, unknown> = {}): PaCall =>
    ({ action: 'sms', body: { to: '48601000001', text, encoding: 'auto', deliveryReport: true, ...extra } } as PaCall);
  type Sent = { kind: 'sent'; messages: Array<{ id: string; links?: { shortened: number; domain: string | null; campaign: string | null } }> };

  it('WyslijSms bez pola skraca link i zwraca blok links z kampanią o nazwie integracji', () => {
    const out = runPowerAutomate(deps, pa(), sms('Raport serwisowy: https://firma.pl/raport.pdf'), meta, NOW) as Sent;
    expect(out.kind).toBe('sent');
    expect(out.messages[0]!.links).toMatchObject({ shortened: 1, domain: 'l.firma.pl', campaign: 'Dyspozytornia' });
    expect(codesIn(body(out.messages[0]!.id))).toHaveLength(1);
  });

  it('WyslijSms z shortenLinks: false przy trybie „Decyduje wysyłający” nie skraca', () => {
    const out = runPowerAutomate(deps, pa(), sms('Raport serwisowy: https://firma.pl/raport.pdf', { shortenLinks: false }), meta, NOW) as Sent;
    expect(out.kind).toBe('sent');
    expect(body(out.messages[0]!.id)).toBe('Raport serwisowy: https://firma.pl/raport.pdf');
    expect(allCampaigns()).toEqual([]);
  });

  it('linkDomain spoza domen klucza kończy wywołanie błędem link_domain_not_allowed bez wysyłki', () => {
    const out = runPowerAutomate(deps, pa(), sms('Raport: https://firma.pl/raport.pdf', { linkDomain: 'inna-firma.pl' }), meta, NOW);
    expect(out.kind).toBe('error');
    expect((out as { error: { code: string } }).error.code).toBe('link_domain_not_allowed');
    expect(deps.messages.list({ limit: 10, offset: 0 })).toHaveLength(0);
  });

  it('WyslijRozsylke z campaign i linkDomain używa wskazanej domeny i nazwy kampanii', () => {
    const call: PaCall = {
      action: 'package',
      body: {
        recipients: [{ to: '48601000001' }, { to: '48601000002' }], defaultText: 'Przegląd klimatyzacji: https://firma.pl/wiosna',
        encoding: 'auto', deliveryReport: true, campaign: 'przeglad-klimatyzacji-wiosna', linkDomain: 'firma-link.pl',
      },
    } as PaCall;
    const out = runPowerAutomate(deps, pa(), call, meta, NOW) as { kind: 'sent'; package: { id: string; links?: unknown } };
    expect(out.kind).toBe('sent');
    expect(out.package.links).toMatchObject({ shortened: 2, domain: 'firma-link.pl', campaign: 'przeglad-klimatyzacji-wiosna' });
    const texts = packages.recipients(out.package.id).map((r) => r.text!);
    expect(texts.every((t) => t.startsWith('Przegląd klimatyzacji: https://firma-link.pl/'))).toBe(true);
    expect(new Set(texts.flatMap(codesIn)).size).toBe(2);
  });

  it('WyslijRozsylke bez nazwy kampanii zakłada kampanię o nazwie integracji', () => {
    const call: PaCall = {
      action: 'package',
      body: { recipients: [{ to: '48601000001' }], defaultText: 'Przegląd: https://firma.pl/wiosna', encoding: 'auto', deliveryReport: true },
    } as PaCall;
    const out = runPowerAutomate(deps, pa(), call, meta, NOW) as { kind: 'sent'; package: { links?: unknown } };
    expect(out.package.links).toMatchObject({ shortened: 1, campaign: 'Dyspozytornia' });
  });

  it('rozsyłka liczy kodowanie po skróceniu: polski znak wyłącznie w adresie linku nie wymusza UCS-2', () => {
    // Szablon ma 77 znaków GSM-7: mieści się w jednej części GSM, ale nie w jednej części UCS-2 (70 znaków).
    const call: PaCall = {
      action: 'package',
      body: {
        recipients: [{ to: '48601000001' }], defaultText: 'Przeglad klimatyzacji - szczegoly i termin wizyty: https://firma.pl/przegląd-wiosna',
        encoding: 'auto', deliveryReport: true,
      },
    } as PaCall;
    const out = runPowerAutomate(deps, pa({ maxParts: 1, overflow: 'reject' }), call, meta, NOW);
    expect(out).toMatchObject({ kind: 'sent', package: { encoding: 'gsm', multipart: false } });
  });

  it('WyslijSmsDoGrupy skraca dla każdego odbiorcy osobno', () => {
    const call = { action: 'group', body: { text: 'Instrukcja: https://firma.pl/instrukcja.pdf', encoding: 'auto', deliveryReport: true } } as PaCall;
    const out = runPowerAutomate(deps, pa(), call, meta, NOW) as Sent;
    expect(out.messages).toHaveLength(2);
    const codes = out.messages.flatMap((m) => codesIn(body(m.id)));
    expect(codes).toHaveLength(2);
    expect(new Set(codes).size).toBe(2);
    expect(out.messages.map((m) => m.links?.shortened)).toEqual([1, 1]);
  });

  it('tryb „przytnij” usuwa przecięty link w całości, a wpis dziennika zgłasza skrócenie', () => {
    const integ = pa({ maxParts: 1, overflow: 'truncate' });
    const out = runPowerAutomate(deps, integ, sms(`${'x'.repeat(140)} https://firma.pl/folder.pdf`), meta, NOW) as Sent;
    expect(body(out.messages[0]!.id)).toBe(`${'x'.repeat(140)} ...`);
    expect(deps.shortLinks.forMessage(out.messages[0]!.id)).toEqual([]);
    expect(deps.integrationEvents.list(integ.id, 1)[0]!.reason).toContain('skrócono do 1 części');
  });
});
