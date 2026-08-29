import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Pkcs12Error, readPkcs12, type CertBundle } from '../../secrets/pkcs12.ts';
import { InvalidOrigError, validateOrig } from '../../text/phone.ts';
import { warsawDay } from '../../time/warsaw.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import {
  accountPage, accountsPage, accountValuesOf, editAccountPage, newAccountPage,
  type AccountFormValues, type AccountView, type ProbeView,
} from '../views/accounts.ts';

/** Największy przyjmowany plik .pfx. Certyfikaty Plusa mieszczą się w kilku kilobajtach. */
const MAX_PFX_BYTES = 512 * 1024;

const TOO_LARGE = 'Plik jest większy niż pół megabajta - to na pewno nie certyfikat.';

interface PfxForm { values: Record<string, string>; file: Buffer | null }

/**
 * Czyta formularz wieloczęściowy z polem `pfx`. Błędy formy żądania (brak formularza
 * wieloczęściowego, plik ponad limit wtyczki) wracają jako komunikat, żeby trasa
 * odpowiedziała stroną z kodem 400, a nie surowym 406/413 w JSON-ie.
 */
async function readPfxForm(request: FastifyRequest): Promise<PfxForm | { error: string }> {
  if (!request.isMultipart()) return { error: 'Formularz musi zawierać plik .pfx.' };
  const values: Record<string, string> = {};
  let file: Buffer | null = null;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file' && part.fieldname === 'pfx') file = await part.toBuffer();
      else if (part.type === 'field') values[part.fieldname] = String(part.value);
    }
  } catch (e) {
    if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') return { error: TOO_LARGE };
    throw e;
  }
  return { values, file };
}

export function registerAccountRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());

  const viewOf = (id: number): AccountView | null => {
    const row = deps.accounts.get(id);
    if (!row) return null;
    const serviceIds = deps.accounts.serviceIds(id);
    const states = new Map(deps.inboundServices.states(id).map((s) => [s.serviceId, s]));
    const at = now();
    return {
      row,
      serviceIds,
      origs: deps.accounts.origs(id),
      keyCount: deps.apiKeys.list().filter((k) => k.accountId === id && k.revokedAt === null).length,
      inbound: serviceIds.map((serviceId) => ({
        serviceId,
        subscribers: deps.apiKeys.inboundSubscribers(id, serviceId, at).map((k) => k.name),
        state: states.get(serviceId) ?? { serviceId, lastPollAt: null, lastReceivedAt: null, error: null },
      })),
    };
  };

  const actorOf = (userId: number | null): string => {
    if (userId === null) return '(nieznany)';
    const login = deps.users.findById(userId)?.login;
    return login ?? String(userId);
  };

  const listPage = (request: FastifyRequest, notice: string | null = null) => render.page(request, {
    title: 'Konta Multiinfo',
    active: 'konta',
    body: accountsPage(
      deps.accounts.list().map((row) => viewOf(row.id)!),
      now(),
      notice,
    ),
  });

  const detailPage = (
    request: FastifyRequest,
    view: AccountView,
    opts: { error?: string | null; bundle?: CertBundle | null; probe?: ProbeView | null } = {},
  ) => render.page(request, {
    title: view.row.name,
    active: 'konta',
    body: accountPage(view, now(), opts),
  });

  app.get('/konta', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return listPage(request);
  });

  app.get('/konta/nowe', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return render.page(request, { title: 'Nowe konto', active: 'konta', body: newAccountPage() });
  });

  app.post('/konta', async (request, reply) => {
    reply.type('text/html; charset=utf-8');

    const form = await readPfxForm(request);
    const values = 'error' in form ? {} : form.values;
    const file = 'error' in form ? null : form.file;

    const fail = (message: string) => {
      reply.code(400);
      const { passphrase: _pominiete, password: _takze, ...bezSekretow } = values;
      return render.page(request, {
        title: 'Nowe konto', active: 'konta',
        body: newAccountPage(message, bezSekretow),
      });
    };
    if ('error' in form) return fail(form.error);

    const name = (values.name ?? '').trim();
    const login = (values.login ?? '').trim();
    const baseUrl = (values.baseUrl ?? '').trim();
    const password = values.password ?? '';
    const serviceIds = (values.serviceIds ?? '').split('\n').map((x) => x.trim()).filter((x) => x.length > 0);

    if (name === '' || login === '' || baseUrl === '' || password === '') {
      return fail('Nazwa, adres bazowy, login i hasło konta są wymagane.');
    }
    if (serviceIds.length === 0) return fail('Podaj przynajmniej jeden identyfikator usługi.');
    if (!/^https:\/\//.test(baseUrl)) return fail('Adres bazowy musi zaczynać się od https://.');
    if (file === null || file.length === 0) return fail('Nie wskazano pliku .pfx.');
    if (file.length > MAX_PFX_BYTES) return fail(TOO_LARGE);

    let bundle: CertBundle;
    try {
      bundle = readPkcs12(file, values.passphrase ?? '');
    } catch (e) {
      if (!(e instanceof Pkcs12Error)) throw e;
      return fail(e.message);
    }

    if (bundle.cn !== login) {
      return fail(`Pole CN certyfikatu (${bundle.cn}) nie zgadza się z podanym loginem (${login}). `
        + 'Multiinfo odrzuciłoby każdą wysyłkę błędem -85.');
    }

    const id = deps.accounts.insert({
      name, baseUrl, login, password,
      certPem: bundle.certPem, keyPem: bundle.keyPem, caPem: bundle.caPem,
      certCn: bundle.cn, certIssuerCn: bundle.issuerCn, certFingerprintSha1: bundle.fingerprintSha1,
      certNotBefore: bundle.notBefore.toISOString(), certNotAfter: bundle.notAfter.toISOString(),
      defaultCountryCode: (values.defaultCountryCode ?? '48').trim() || '48',
      defaultOrig: null,
      // Treść SMS-a to dane osobowe - przechowujemy ją tylko na wyraźne życzenie.
      storeContent: values.storeContent === '1' ? 1 : 0,
      serviceIds,
    });

    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'konto.utworzenie', target: `konto:${id}`,
      meta: { nazwa: name, login, cn: bundle.cn, fingerprint: bundle.fingerprintSha1 },
      ip: request.ip,
    });
    render.flash(request, 'ok', `Konto ${name} zapisane.`);
    return reply.redirect(`/konta/${id}`, 302);
  });

  app.get<{ Params: { id: string } }>('/konta/:id', async (request, reply) => {
    const view = viewOf(Number(request.params.id));
    if (!view) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');
    return detailPage(request, view);
  });

  app.get<{ Params: { id: string } }>('/konta/:id/edytuj', async (request, reply) => {
    const view = viewOf(Number(request.params.id));
    if (!view) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');
    return render.page(request, { title: `Edycja: ${view.row.name}`, active: 'konta', body: editAccountPage(view) });
  });

  app.post<{ Params: { id: string }; Body: Record<string, string | undefined> }>('/konta/:id/edytuj', async (request, reply) => {
    const view = viewOf(Number(request.params.id));
    if (!view) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');
    const body = request.body ?? {};
    const values: AccountFormValues = {
      name: (body.name ?? '').trim(), baseUrl: (body.baseUrl ?? '').trim(),
      defaultCountryCode: (body.defaultCountryCode ?? '').trim(),
      storeContent: body.storeContent === '1' ? '1' : '0', serviceIds: body.serviceIds ?? '',
    };
    const password = body.password ?? '';
    const serviceIds = [...new Set(values.serviceIds.split('\n').map((x) => x.trim()).filter((x) => x.length > 0))];

    const fail = (message: string) => {
      reply.code(400);
      return render.page(request, {
        title: `Edycja: ${view.row.name}`, active: 'konta', body: editAccountPage(view, message, values),
      });
    };
    if (values.name === '' || values.baseUrl === '') return fail('Nazwa i adres bazowy są wymagane.');
    if (!/^https:\/\//.test(values.baseUrl)) return fail('Adres bazowy musi zaczynać się od https://.');
    if (serviceIds.length === 0) return fail('Podaj przynajmniej jedno ID usługi.');
    if (values.defaultCountryCode === '') return fail('Podaj domyślny kod kraju.');

    // Odebranie usługi, z której korzysta czynny klucz, zepsułoby ten klucz po cichu.
    const inUse = deps.apiKeys.serviceIdsInUse(view.row.id);
    const blocked = view.serviceIds.filter((id) => !serviceIds.includes(id) && inUse.has(id));
    if (blocked.length > 0) {
      const first = blocked[0]!;
      return fail(`ID usługi ${first} jest używane przez klucze: ${inUse.get(first)!.join(', ')}. `
        + 'Najpierw zmień lub odwołaj te klucze.');
    }

    const before = accountValuesOf(view);
    const credentialsChanged = password !== '' || values.baseUrl !== view.row.baseUrl;
    deps.accounts.update(view.row.id, {
      name: values.name, baseUrl: values.baseUrl, ...(password === '' ? {} : { password }),
      defaultCountryCode: values.defaultCountryCode, storeContent: values.storeContent === '1' ? 1 : 0, serviceIds,
    });
    // Zmiana listy usług zapala albo gasi odbiór; usługa zatrzymana błędem Multiinfo dostaje nową szansę.
    deps.receiver?.refresh({ retryStopped: true });
    const after = accountValuesOf(viewOf(view.row.id)!);
    const changed: string[] = (Object.keys(after) as Array<keyof AccountFormValues>).filter((k) => after[k] !== before[k]);
    if (password !== '') changed.push('password');
    // W dzienniku nazwy pól, nigdy hasło.
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'konto.edycja', target: `konto:${view.row.id}`,
      meta: { nazwa: values.name, pola: changed }, ip: request.ip,
    });

    if (!credentialsChanged) {
      render.flash(request, 'ok', `Konto ${values.name} zapisane.`);
      return reply.redirect(`/konta/${view.row.id}`, 302);
    }

    // Nowe hasło albo adres: stary klient trzyma stare dane, więc go unieważniamy i od razu sprawdzamy.
    // Porażka nie wstrzymuje konta - literówka w haśle nie ma zatrzymać kolejki w środku dnia.
    deps.clients.invalidate(view.row.id);
    const result = await deps.clients.for(view.row.id).probe();
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'konto.sprawdzenie', target: `konto:${view.row.id}`,
      meta: result.ok ? { wynik: 'ok' } : { wynik: 'blad', kod: result.code }, ip: request.ip,
    });
    if (result.ok) {
      const resumed = resumeIfPaused(view.row, request.adminUserId, request.ip, 'udane sprawdzenie po edycji');
      render.flash(request, 'ok', `Konto ${values.name} zapisane. Połączenie z Multiinfo działa (-31).`
        + (resumed ? ' Konto zostało wznowione - wiadomości z kolejki ruszą w ciągu minuty.' : ''));
    } else {
      render.flash(request, 'warn', `Konto ${values.name} zapisane, ale sprawdzenie połączenia nie powiodło się: `
        + `${result.message} (${result.code}). Konto nie zostało wstrzymane.`);
    }
    return reply.redirect(`/konta/${view.row.id}`, 302);
  });

  app.post<{ Params: { id: string } }>('/konta/:id/certyfikat', async (request, reply) => {
    const view = viewOf(Number(request.params.id));
    if (!view) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');

    const form = await readPfxForm(request);
    if ('error' in form) {
      reply.code(400);
      return detailPage(request, view, { error: form.error });
    }
    const { file } = form;
    const passphrase = form.values.passphrase ?? '';

    if (file === null || file.length === 0) {
      reply.code(400);
      return detailPage(request, view, { error: 'Nie wskazano pliku .pfx.' });
    }
    if (file.length > MAX_PFX_BYTES) {
      reply.code(400);
      return detailPage(request, view, { error: TOO_LARGE });
    }

    let bundle: CertBundle;
    try {
      bundle = readPkcs12(file, passphrase);
    } catch (e) {
      if (!(e instanceof Pkcs12Error)) throw e;
      reply.code(400);
      return detailPage(request, view, { error: e.message });
    }

    // Niezgodność CN jest przyczyną błędu -85 przy każdej wysyłce, więc nie pozwalamy
    // zapisać takiego certyfikatu - zamiast tego mówimy wprost, co się nie zgadza.
    if (bundle.cn !== view.row.login) {
      reply.code(400);
      return detailPage(request, view, {
        bundle,
        error: `Pole CN certyfikatu (${bundle.cn}) nie zgadza się z loginem konta (${view.row.login}). `
          + 'Multiinfo odrzuciłoby każdą wysyłkę błędem -85, więc certyfikat nie został zapisany.',
      });
    }

    deps.accounts.updateCertificate(view.row.id, bundle, deps.masterKey);
    deps.clients.invalidate(view.row.id);
    deps.audit.record({
      actor: actorOf(request.adminUserId),
      action: 'certyfikat.wymiana',
      target: `konto:${view.row.id}`,
      meta: {
        cn: bundle.cn,
        fingerprint: bundle.fingerprintSha1,
        notAfter: bundle.notAfter.toISOString(),
      },
      ip: request.ip,
    });
    // Nowy certyfikat to nowa szansa: kolejka rusza, a jeśli Plus znów odrzuci
    // materiał, worker wstrzyma konto ponownie z aktualnym powodem.
    const resumed = resumeIfPaused(view.row, request.adminUserId, request.ip, 'wymiana certyfikatu');
    render.flash(request, 'ok',
      `Certyfikat wczytany. CN ${bundle.cn}, ważny do ${warsawDay(bundle.notAfter.toISOString())}.`
      + (resumed ? ' Konto zostało wznowione - wiadomości z kolejki ruszą w ciągu minuty.' : ''));
    return reply.redirect(`/konta/${view.row.id}`, 302);
  });

  app.post<{ Params: { id: string } }>('/konta/:id/sprawdz', async (request, reply) => {
    const view = viewOf(Number(request.params.id));
    if (!view) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');

    // Zegar mierzymy własnym licznikiem, a nie zegarem wstrzykniętym przez testy:
    // ten drugi bywa nieruchomy i pokazałby zawsze zero milisekund.
    const started = process.hrtime.bigint();
    const client = deps.clients.for(view.row.id);
    const result = await client.probe();
    // Drugie zapytanie jest pomocnicze: gdy strona diagnostyczna nie odpowie,
    // wynik sprawdzenia i tak stoi na kodzie z infosms.aspx.
    const certificate = await client.inspectCertificate().catch(() => null);
    const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);

    deps.audit.record({
      actor: actorOf(request.adminUserId),
      action: 'konto.sprawdzenie',
      target: `konto:${view.row.id}`,
      meta: result.ok ? { wynik: 'ok' } : { wynik: 'blad', kod: result.code },
      ip: request.ip,
    });

    // Udane sprawdzenie dowodzi, że przyczyna wstrzymania zniknęła - certyfikat
    // i logowanie przeszły. To najbardziej wiarygodny moment na wznowienie kolejki.
    const resumed = result.ok && resumeIfPaused(view.row, request.adminUserId, request.ip, 'udane sprawdzenie');

    const probe: ProbeView = result.ok
      ? { accountId: view.row.id, ok: true, code: null, message: '', durationMs, at: now(), resumed, certificate }
      : { accountId: view.row.id, ok: false, code: result.code, message: result.message, durationMs, at: now(), resumed: false, certificate };

    return detailPage(request, viewOf(view.row.id) ?? view, { probe });
  });

  /** Zdejmuje wstrzymanie założone przez workera. Zwraca prawdę, jeśli było co zdejmować. */
  function resumeIfPaused(row: AccountView['row'], userId: number | null, ip: string, cause: string): boolean {
    if (row.pausedReason === null) return false;
    deps.accounts.resume(row.id);
    deps.receiver?.refresh({ retryStopped: true });
    deps.audit.record({
      actor: actorOf(userId),
      action: 'konto.wznowienie',
      target: `konto:${row.id}`,
      meta: { powod: cause, wstrzymane_z_powodu: row.pausedReason },
      ip,
    });
    return true;
  }

  app.post<{ Params: { id: string }; Body: { origs?: string; defaultOrig?: string } }>(
    '/konta/:id/nadpisy',
    async (request, reply) => {
      const view = viewOf(Number(request.params.id));
      if (!view) return reply.callNotFound();
      reply.type('text/html; charset=utf-8');

      const wpisane = (request.body?.origs ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const orig of wpisane) {
        try {
          validateOrig(orig);
        } catch (e) {
          if (!(e instanceof InvalidOrigError)) throw e;
          reply.code(400);
          return listPage(request, e.message);
        }
      }

      const unikalne = [...new Set(wpisane)];
      const defaultOrig = (request.body?.defaultOrig ?? '').trim();
      if (defaultOrig !== '' && !unikalne.includes(defaultOrig)) {
        reply.code(400);
        return listPage(request, `Wartość domyślna „${defaultOrig}” jest spoza słownika nadpisów tego konta.`);
      }

      deps.accounts.setOrigs(view.row.id, unikalne.map((orig) => ({ orig, label: null })));
      deps.accounts.setDefaultOrig(view.row.id, defaultOrig === '' ? null : defaultOrig);
      deps.audit.record({
        actor: actorOf(request.adminUserId),
        action: 'konto.nadpisy',
        target: `konto:${view.row.id}`,
        meta: { nadpisy: unikalne, domyslny: defaultOrig || null },
        ip: request.ip,
      });
      render.flash(request, 'ok', `Nadpisy konta ${view.row.name} zapisane.`);
      return reply.redirect('/konta', 302);
    },
  );
}
