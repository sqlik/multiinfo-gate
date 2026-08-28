import { Agent, request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { ProviderError, classifyCode, parsePackageFullInfo, parseResponse } from './response.ts';

export interface ClientCredentials {
  baseUrl: string;
  login: string;
  password: string;
  certPem: string;
  keyPem: string;
  /**
   * Łańcuch certyfikatu klienta (CA pośrednie z pliku .pfx). Idzie do serwera razem
   * z certyfikatem, żeby ten mógł zbudować ścieżkę do znanego sobie korzenia. Nie służy
   * do weryfikacji serwera - certyfikat Multiinfo wystawia publiczne CA z magazynu Node.
   */
  caPem: string | null;
}

export interface ClientOptions {
  /**
   * Dodatkowe CA zaufane przy weryfikacji serwera, dokładane do wbudowanego magazynu Node.
   * Bramka tego nie ustawia; potrzebne testom z lokalnym serwerem o własnym CA.
   */
  extraServerCa?: string;
}

export interface SendLongParams {
  serviceId: string;
  dest: string;
  text: string;
  orig?: string;
  validTo?: Date;
  costCenter?: string;
  deliveryReport: boolean;
  advancedEncoding: boolean;
  deleteContent: boolean;
}

export interface MessageInfo {
  miId: string;
  status: number;
  substatus: number;
  dest: string;
  orig: string;
  changedAt: string;
}

export type ProbeResult = { ok: true } | { ok: false; code: number; message: string };

/**
 * Certyfikat kliencki tak, jak widzi go serwer Multiinfo na stronie test.aspx.
 * `seen: false` oznacza, że uzgodnienie TLS przeszło bez certyfikatu albo strona
 * odpowiedziała czymś, czego nie umiemy odczytać - wtedy `message` niesie jej tekst.
 */
export type CertificateView =
  | { seen: true; subject: string; subjectCn: string | null; issuer: string; issuerCn: string | null; validTo: string }
  | { seen: false; message: string };

export interface SendResult { miIds: string[]; trace: ProtocolTrace }

export interface PackageRecipient { dest: string; text: string | null; clientId: string | null }

export interface PackageParams {
  serviceId: string;
  defaultText: string | null;
  recipients: PackageRecipient[];
  orig?: string;
  costCenter?: string;
  startAt?: Date;
  deliveryReport: boolean;
  advancedEncoding: boolean;
  multipart: boolean;
}

export interface PackageInfo { miPackageId: string; saved: number; remaining: number; status: number }

export interface PackageReportInfo { reportId: string; generation: 0 | 1 | 2 | 3; minutesLeft: number }

/**
 * Tabela parametrów w PDF v6.1 mówi `dests`, przykład żądania - powtórzone `dest=`.
 * Przy `text`/`data` rację miał przykład. Jedno miejsce do zmiany, gdyby było inaczej.
 */
export const PACKAGE_DEST_PARAM = 'dest';

/** Zamiast hasła w śladzie protokołu. */
const MASKED = '••••••••';

/** Odbiorca w formacie z §2.6: numer, opcjonalnie [identyfikator], opcjonalnie ,treść. */
export function formatPackageRecipient(r: PackageRecipient): string {
  const id = r.clientId === null ? '' : `[${r.clientId}]`;
  const text = r.text === null ? '' : `,${r.text}`;
  return `${r.dest}${id}${text}`;
}

/** Ślad jednego wywołania Multiinfo. Hasło zawsze zamaskowane, treść tylko przy przechowywaniu. */
export interface ProtocolTrace {
  at: string;
  durationMs: number;
  script: string;
  params: Record<string, string>;
  httpStatus: number;
  lines: string[];
}

/**
 * Strefa, w której Multiinfo czyta daty. Dokumentacja podaje tylko format
 * `yyyyMMddhhmmss`, bez strefy - system Polkomtela pracuje w czasie polskim.
 * Nie polegamy na strefie procesu: kontener działa zwykle w UTC.
 */
export const OPERATOR_TIME_ZONE = 'Europe/Warsaw';

const OPERATOR_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: OPERATOR_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

/** Data w formacie yyyyMMddhhmmss, w czasie polskim. */
export function formatOperatorTime(d: Date): string {
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    OPERATOR_CLOCK.formatToParts(d).find((p) => p.type === type)?.value ?? '00';
  return `${part('year')}${part('month')}${part('day')}${part('hour')}${part('minute')}${part('second')}`;
}

/** Numery wierszy odpowiedzi infosms.aspx, liczone od zera po odcięciu linii statusu. */
const INFO_LINE = { miId: 0, orig: 12, dest: 13, status: 14, substatus: 15, changedAt: 16 } as const;

const REQUEST_TIMEOUT_MS = 30_000;

interface RawReply { body: Buffer; status: number; durationMs: number }

export class MultiinfoClient {
  private readonly agent: Agent;

  constructor(private readonly creds: ClientCredentials, options: ClientOptions = {}) {
    this.agent = new Agent({
      // Opcja `ca` zastępuje wbudowany magazyn zaufanych CA, więc łańcuch z .pfx nie może
      // tam trafić - bramka przestałaby ufać certyfikatowi serwera Multiinfo.
      cert: creds.caPem ? creds.certPem + creds.caPem : creds.certPem,
      key: creds.keyPem,
      ...(options.extraServerCa ? { ca: [...rootCertificates, options.extraServerCa] } : {}),
      keepAlive: true,
      maxSockets: 4,
    });
  }

  close(): void {
    this.agent.destroy();
  }

  /**
   * Wywołanie idzie przez `node:https`, a nie przez `fetch`: wbudowany fetch Node
   * ignoruje przekazany agent, więc certyfikat kliencki nigdy by nie dotarł do
   * uzgadniania TLS. Cała komunikacja z Multiinfo to POST formularza. Parametry
   * idą jako `URLSearchParams`, bo `package.aspx` powtarza `dest` dla każdego odbiorcy.
   */
  private call(script: string, params: URLSearchParams): Promise<RawReply> {
    const url = new URL(script, this.creds.baseUrl);
    const form = new URLSearchParams({ login: this.creds.login, password: this.creds.password });
    for (const [k, v] of params) form.append(k, v);
    return this.transport(url, 'POST', form.toString());
  }

  /** Żądanie GET bez poświadczeń - tylko dla strony test.aspx, która ich nie czyta. */
  private fetchPage(url: URL): Promise<RawReply> {
    return this.transport(url, 'GET', null);
  }

  private transport(url: URL, method: 'GET' | 'POST', body: string | null): Promise<RawReply> {
    const started = process.hrtime.bigint();
    const elapsedMs = () => Number((process.hrtime.bigint() - started) / 1_000_000n);

    return new Promise<RawReply>((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method,
          agent: this.agent,
          headers: body === null ? {} : {
            'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new ProviderError(-71, `Multiinfo odpowiedziało kodem HTTP ${status}`, 'transient'));
              return;
            }
            resolve({ body: Buffer.concat(chunks), status, durationMs: elapsedMs() });
          });
        },
      );

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new ProviderError(-71, 'Multiinfo nie odpowiedziało w wyznaczonym czasie', 'transient'));
      });
      // Komunikat błędu sieci nie zawiera poświadczeń - w żądaniu idą one w treści, nie w adresie.
      req.on('error', (e) => {
        reject(e instanceof ProviderError ? e : new ProviderError(-71, `Nie udało się połączyć: ${e.message}`, 'transient'));
      });
      req.end(body ?? undefined);
    });
  }

  private async text(script: string, params: Record<string, string> | URLSearchParams): Promise<string> {
    const p = params instanceof URLSearchParams ? params : new URLSearchParams(params);
    return (await this.call(script, p)).body.toString('utf8');
  }

  private static unwrap(body: string): string[] {
    const parsed = parseResponse(body);
    if (!parsed.ok) throw new ProviderError(parsed.code, parsed.message, classifyCode(parsed.code));
    return parsed.lines;
  }

  /** Zwraca identyfikatory wszystkich części wiadomości, po jednym na część, wraz ze śladem wywołania. */
  async sendLong(p: SendLongParams): Promise<SendResult> {
    const params: Record<string, string> = {
      serviceId: p.serviceId,
      dest: p.dest,
      // Nazwa parametru to `text`, nie `data`. Tabela w dokumentacji v6.1 się myli.
      text: p.text,
      delivNotifRequest: String(p.deliveryReport),
      advancedEncoding: String(p.advancedEncoding),
      deleteContent: String(p.deleteContent),
    };
    if (p.orig !== undefined) params.orig = p.orig;
    if (p.validTo !== undefined) params.validTo = formatOperatorTime(p.validTo);
    if (p.costCenter !== undefined) params.costCenter = p.costCenter;

    const at = new Date().toISOString();
    const res = await this.call('sendsmslong.aspx', new URLSearchParams(params));
    const lines = MultiinfoClient.unwrap(res.body.toString('utf8'));
    return {
      miIds: lines,
      trace: {
        at,
        durationMs: res.durationMs,
        script: 'sendsmslong.aspx',
        params: { login: this.creds.login, password: MASKED, ...params },
        httpStatus: res.status,
        lines,
      },
    };
  }

  /** Anuluje jedną część wiadomości; -41 znaczy, że część poszła już do abonenta. */
  async cancel(smsId: string): Promise<void> {
    MultiinfoClient.unwrap(await this.text('cancelsms.aspx', { smsId }));
  }

  /** Tworzy rozsyłkę i zwraca jej identyfikator w Multiinfo. */
  async createPackage(p: PackageParams): Promise<string> {
    const params = new URLSearchParams({
      serviceId: p.serviceId,
      delivNotifRequest: String(p.deliveryReport),
      advancedEncoding: String(p.advancedEncoding),
      isMultiPart: String(p.multipart),
    });
    // Treść domyślna, jak w sendsmslong, to `text`.
    if (p.defaultText !== null) params.set('text', p.defaultText);
    if (p.orig !== undefined) params.set('orig', p.orig);
    if (p.costCenter !== undefined) params.set('costCenter', p.costCenter);
    if (p.startAt !== undefined) params.set('startDate', formatOperatorTime(p.startAt));
    for (const r of p.recipients) params.append(PACKAGE_DEST_PARAM, formatPackageRecipient(r));

    const lines = MultiinfoClient.unwrap(await this.text('package.aspx', params));
    const id = lines[0]?.trim();
    if (!id) throw new ProviderError(-71, 'package.aspx nie zwróciło identyfikatora rozsyłki', 'transient');
    return id;
  }

  async packageInfo(miPackageId: string): Promise<PackageInfo> {
    const l = MultiinfoClient.unwrap(await this.text('packageinfo.aspx', { packageId: miPackageId }));
    return {
      miPackageId: l[0] ?? miPackageId,
      saved: Number.parseInt(l[1] ?? '0', 10) || 0,
      remaining: Number.parseInt(l[2] ?? '0', 10) || 0,
      status: Number.parseInt(l[3] ?? '', 10),
    };
  }

  /** Zamawia raport rozsyłki albo pyta o postęp jego generowania. */
  async packageFullInfo(miPackageId: string, format: 'csv'): Promise<PackageReportInfo> {
    const parsed = parsePackageFullInfo(
      await this.text('packagefullinfo.aspx', { packageId: miPackageId, fileFormat: format }),
    );
    if (!parsed.ok) throw new ProviderError(parsed.code, parsed.message, classifyCode(parsed.code));
    return { reportId: parsed.reportId, generation: parsed.generation, minutesLeft: parsed.minutesLeft };
  }

  /** Odpowiedź to archiwum ZIP; błąd przychodzi jako tekst z kodem w pierwszej linii. */
  async getReport(reportId: string): Promise<Buffer> {
    const res = await this.call('getreport.aspx', new URLSearchParams({ reportId }));
    const head = res.body.subarray(0, 16).toString('latin1');
    if (/^-\d+(\r?\n|$)/.test(head)) {
      MultiinfoClient.unwrap(res.body.toString('utf8'));
    }
    return res.body;
  }

  async info(smsId: string): Promise<MessageInfo> {
    const lines = MultiinfoClient.unwrap(await this.text('infosms.aspx', { smsId }));
    return {
      miId: lines[INFO_LINE.miId] ?? smsId,
      status: Number.parseInt(lines[INFO_LINE.status] ?? '', 10),
      substatus: Number.parseInt(lines[INFO_LINE.substatus] ?? '0', 10),
      dest: lines[INFO_LINE.dest] ?? '',
      orig: lines[INFO_LINE.orig] ?? '',
      changedAt: lines[INFO_LINE.changedAt] ?? '',
    };
  }

  /**
   * Sprawdza certyfikat i logowanie, nie wysyłając wiadomości: pyta o nieistniejącą
   * wiadomość o identyfikatorze 0. Oczekiwana odpowiedź to -31 i jest ona wynikiem
   * pozytywnym - dowodzi, że TLS i logowanie przeszły.
   */
  async probe(): Promise<ProbeResult> {
    const parsed = parseResponse(await this.text('infosms.aspx', { smsId: '0' }));
    if (parsed.ok) return { ok: true };
    if (parsed.code === -31) return { ok: true };
    return { ok: false, code: parsed.code, message: parsed.message };
  }

  /**
   * Pyta stronę test.aspx, jak serwer Multiinfo widzi przedstawiony certyfikat. Strona
   * nie jest opisana w dokumentacji API, stoi pod korzeniem hosta (nie pod /Api61/),
   * nie czyta loginu ani hasła i zawsze odpowiada HTML z kodem 200 - stąd osobne żądanie
   * GET i czytanie tekstu po zdjęciu znaczników. Wynik uzupełnia probe(): tamto mówi,
   * czy Multiinfo przyjęło certyfikat i logowanie, to - co dokładnie zobaczyło.
   */
  async inspectCertificate(): Promise<CertificateView> {
    const url = new URL('/test.aspx', this.creds.baseUrl);
    const reply = await this.fetchPage(url);
    return parseCertificatePage(reply.body.toString('utf8'));
  }
}

/** Tekst strony test.aspx bez znaczników; <br> jako koniec wiersza, puste wiersze pominięte. */
function pageLines(html: string): string[] {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Wartość pola z nazwy wyróżnionej (DN), np. CN z "C=PL, O=Polkomtel, CN=firma". */
function dnField(dn: string, name: string): string | null {
  const match = new RegExp(`(?:^|,\\s*)${name}=([^,]*)`).exec(dn);
  return match?.[1] === undefined ? null : match[1].trim();
}

export function parseCertificatePage(html: string): CertificateView {
  const lines = pageLines(html);
  const field = (label: string): string | null => {
    const line = lines.find((l) => l.startsWith(label));
    return line === undefined ? null : line.slice(label.length).trim();
  };
  const subject = field('Podmiot:');
  const issuer = field('Wystawca:');
  const validTo = field('Ważny do:');
  if (subject !== null && issuer !== null && validTo !== null) {
    return {
      seen: true,
      subject,
      subjectCn: dnField(subject, 'CN'),
      issuer,
      issuerCn: dnField(issuer, 'CN'),
      validTo,
    };
  }
  return { seen: false, message: lines[0] ?? '' };
}
