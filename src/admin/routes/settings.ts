import type { FastifyInstance } from 'fastify';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';

type Body = Record<string, string | string[] | undefined>;

/** Adres bramki: http(s), host i opcjonalny port, bez ścieżki - ścieżki dokleja panel. */
export function parseApiUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/.test(trimmed)) {
    return { ok: false, error: 'Adres bramki: podaj http:// albo https://, host i ewentualnie port, bez ścieżki, np. https://sms.firma.pl albo http://10.10.10.159:8080.' };
  }
  try {
    const u = new URL(trimmed);
    if (u.username !== '' || u.password !== '') return { ok: false, error: 'Adres bramki nie może zawierać loginu ani hasła.' };
  } catch {
    return { ok: false, error: 'Adres bramki nie jest poprawnym adresem.' };
  }
  return { ok: true, url: trimmed };
}

export function registerSettingsRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());
  const actorOf = (userId: number | null): string => (userId === null ? '(nieznany)' : deps.users.findById(userId)?.login ?? String(userId));

  app.post<{ Body: Body }>('/adres-bramki', async (request, reply) => {
    const body = request.body ?? {};
    // Powrót tylko na stronę panelu - nigdy na obcy adres. Ukośnik wsteczny przeglądarki czytają
    // jak zwykły, więc „/\\obcy.example” też jest obcym adresem.
    const backRaw = String(body.wroc ?? '/klucze');
    const back = /^\/(?![/\\])[^\\]*$/.test(backRaw) ? backRaw : '/klucze';
    const clear = String(body.wyczysc ?? '') === '1';
    const raw = String(body.apiUrl ?? '');
    if (!clear) {
      const parsed = parseApiUrl(raw);
      if (!parsed.ok) {
        render.flash(request, 'fail', parsed.error);
        return reply.redirect(back, 302);
      }
      deps.settings.setApiUrl(parsed.url, now());
    } else {
      deps.settings.setApiUrl(null, now());
    }
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'ustawienia.adres_bramki', target: 'ustawienia',
      meta: { adres: clear ? null : parseApiUrl(raw).ok ? raw.trim().replace(/\/+$/, '') : null }, ip: request.ip,
    });
    render.flash(request, 'ok', clear ? 'Adres bramki wyczyszczony.' : 'Adres bramki zapisany.');
    return reply.redirect(back, 302);
  });

  /** Odłożenie wydania: pasek i znacznik znikają dla tego numeru, wracają przy nowszym. */
  app.post<{ Body: Body }>('/wydanie/odloz', async (request, reply) => {
    const version = String(request.body?.version ?? '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      render.flash(request, 'fail', 'Nieznany numer wydania.');
      return reply.redirect('/przeglad', 302);
    }
    deps.settings.setDismissedRelease(version, now());
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'ustawienia.wydanie_odlozone', target: 'ustawienia', meta: { wydanie: version }, ip: request.ip,
    });
    render.flash(request, 'ok', `Wydanie ${version} odłożone. Panel przypomni przy następnym.`);
    return reply.redirect('/przeglad', 302);
  });
}
