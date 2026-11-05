// Parser, authserv-id, oznaczenie wewnętrzne Exchange i wpis dziennika z tematem maila.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultMailInConfig, type MailInConfig } from '../../src/integrations/config.ts';
import { authservIdOf } from '../../src/integrations/mail/auth-results.ts';
import { parseMail } from '../../src/integrations/mail/parse.ts';
import { runMailIn, subjectNote, type MailInIntegration } from '../../src/integrations/pipeline.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { M365_IMAP } from '../../src/m365/oauth.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-11-04T10:00:00Z');
const fixture = (name: string) => readFileSync(new URL(`../fixtures/mail/${name}`, import.meta.url)).toString('utf8');

describe('authserv-id z nagłówka bez nazwy serwera', () => {
  it('starsza postać Exchange Online („spf=pass (…) smtp.mailfrom=…”) nie daje nazwy serwera „spf=pass”', () => {
    // Postać z maili Exchange Online sprzed października 2026 (NOTATKA, nagłówki uid 2558, 2612, 2623).
    expect(authservIdOf('spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=przyklad.pl; dkim=pass (signature was verified) header.d=przyklad.pl;dmarc=pass action=none header.from=przyklad.pl;compauth=pass reason=100')).toBeNull();
    expect(authservIdOf('dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=firma.pl;')).toBeNull();
    // Postać z nazwą serwera zostaje bez zmian.
    expect(authservIdOf('mx.microsoft.com 1; spf=pass smtp.mailfrom=przyklad.pl')).toBe('mx.microsoft.com');
  });
});

describe('kilka nagłówków From', () => {
  it('mail z dwoma nagłówkami From nie ma nadawcy, tak jak mail z dwoma adresami w jednym nagłówku', async () => {
    const source = fixture('m365-wewnetrzny-outlook.eml').replace('From: Jan Kowalski <jan.kowalski@firma.pl>', 'From: Prezes <prezes@firma.pl>\r\nFrom: Jan Kowalski <jan.kowalski@firma.pl>');
    const mail = await parseMail(Buffer.from(source), NOW);
    expect(mail.from).toBe('');
  });
});

describe('wpis dziennika z tematem maila', () => {
  it('temat ucięty bez rozcinania pary zastępczej i bez znaków sterujących oraz znaków kierunku tekstu', () => {
    const note = subjectNote(`a${'😀'.repeat(60)}`);
    expect(note).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(note).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(subjectNote('Faktura‮fdp.exe\u0007\u0000')).toBe('temat „Fakturafdp.exe”');
  });
});

describe('oznaczenie wewnętrzne Exchange przy jawnej porażce DMARC/compauth', () => {
  let deps: Parameters<typeof runMailIn>[0];
  let integrations: IntegrationsRepo;
  let apiKeyId: number;

  beforeEach(() => {
    const db = openDatabase(':memory:');
    const key = randomBytes(32);
    const accounts = new AccountsRepo(db, key);
    const accountId = accounts.insert(accountInput({ storeContent: 1 }));
    const apiKeys = new ApiKeysRepo(db, key);
    apiKeyId = apiKeys.insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
    integrations = new IntegrationsRepo(db, key);
    deps = {
      accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
      inbound: new InboundMessagesRepo(db), integrationEvents: new IntegrationEventsRepo(db, key), guards: new IntegrationGuardsRepo(db),
      engine: new TemplateEngine(), integrations,
    };
  });

  const m365 = () => {
    const config: MailInConfig = {
      ...defaultMailInConfig(), requireAuthResults: true, senders: [{ pattern: '@firma.pl', recipients: [] }], to: { fallback: ['48601000009'] },
      imap: { ...M365_IMAP, user: 'alarmy@firma.pl', passRef: 'imap_password', auth: { mode: 'm365', accountId: 1 } },
    };
    const id = integrations.insert({ name: 'Skrzynka', kind: 'mail_in', apiKeyId, serviceId: null, orig: null, preset: 'poczta-m365', enabled: 1, config, secrets: {}, storePayloads: 0, createdAt: NOW });
    return integrations.get(id) as MailInIntegration;
  };

  it('AuthAs: Internal nie wystarcza, gdy Exchange zapisał w Authentication-Results dmarc=fail albo compauth=fail dla domeny nadawcy', async () => {
    // Scenariusz: mail podszywający się z zewnątrz pod prezes@firma.pl przeszedł przez przekierowanie regułą skrzynki
    // pracownika (ponowne przesłanie wewnątrz organizacji) i ma już oznaczenie Internal, ale zachował pierwotny wynik Exchange.
    const source = fixture('m365-wewnetrzny-outlook.eml')
      .replace('From: Jan Kowalski <jan.kowalski@firma.pl>', 'From: Prezes <prezes@firma.pl>')
      .replace('MIME-Version: 1.0\n', 'MIME-Version: 1.0\nAuthentication-Results: mx.microsoft.com 1; spf=fail (sender IP is 198.51.100.7)\n smtp.mailfrom=firma.pl; dkim=none (message not signed) header.d=none;dmarc=fail\n action=none header.from=firma.pl;compauth=fail reason=000\n')
      .replace('MIME-Version: 1.0\r\n', 'MIME-Version: 1.0\r\nAuthentication-Results: mx.microsoft.com 1; spf=fail (sender IP is 198.51.100.7)\r\n smtp.mailfrom=firma.pl; dkim=none (message not signed) header.d=none;dmarc=fail\r\n action=none header.from=firma.pl;compauth=fail reason=000\r\n');
    const mail = await parseMail(Buffer.from(source), NOW);
    expect(mail.exchangeAuthAs).toBe('internal');
    expect(mail.authResults).toHaveLength(1);
    expect(await runMailIn(deps, m365(), mail, NOW)).toEqual({ kind: 'skipped', reason: 'auth_failed' });
  });
});
