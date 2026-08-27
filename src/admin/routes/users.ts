import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { SESSION_COOKIE, hashPassword, verifyPassword } from '../session.ts';
import { UserInputError, createAdminUser, validatePassword } from '../users.ts';
import { newUserPage, passwordPage, usersPage } from '../views/users.ts';

export function registerUserRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const actorOf = (userId: number | null): string => {
    if (userId === null) return '(nieznany)';
    return deps.users.findById(userId)?.login ?? String(userId);
  };

  const listPage = (request: FastifyRequest) => render.page(request, {
    title: 'Użytkownicy panelu', active: 'uzytkownicy',
    body: usersPage(deps.users.list(), request.adminUserId!),
  });

  app.get('/uzytkownicy', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return listPage(request);
  });

  type NewBody = { login?: string; haslo?: string; haslo2?: string };

  app.get('/uzytkownicy/nowy', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return render.page(request, { title: 'Nowy użytkownik', active: 'uzytkownicy', body: newUserPage() });
  });

  app.post<{ Body: NewBody }>('/uzytkownicy/nowy', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const login = (request.body?.login ?? '').trim();
    const password = request.body?.haslo ?? '';
    const again = request.body?.haslo2 ?? '';

    const fail = (message: string) => {
      reply.code(400);
      return render.page(request, { title: 'Nowy użytkownik', active: 'uzytkownicy', body: newUserPage(message, { login }) });
    };

    if (password !== again) return fail('Hasła różnią się.');
    let id: number;
    try {
      id = await createAdminUser(deps.users, login, password);
    } catch (e) {
      if (e instanceof UserInputError) return fail(e.message);
      throw e;
    }

    // W dzienniku login i numer - nigdy hasło.
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'uzytkownik.utworzenie',
      target: `uzytkownik:${id}`, meta: { login }, ip: request.ip,
    });
    render.flash(request, 'ok', `Użytkownik ${login} dodany. Przekaż mu hasło startowe - przy pierwszym logowaniu `
      + 'panel poprosi o włączenie drugiego składnika i pokaże kody zapasowe.');
    return reply.redirect('/uzytkownicy', 302);
  });

  /** Strona listy z komunikatem błędu i kodem 400 - bez przekierowania, bo błąd dotyczy tej samej strony. */
  const listWithFail = (request: FastifyRequest, reply: FastifyReply, message: string) => {
    render.flash(request, 'fail', message);
    reply.code(400);
    return listPage(request);
  };

  app.post<{ Params: { id: string } }>('/uzytkownicy/:id/usun', async (request, reply) => {
    const id = Number(request.params.id);
    const user = deps.users.findById(id);
    if (!user) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');
    // Najpierw liczba kont: jedyne konto jest zawsze własne, a „ostatnie” to dokładniejszy powód odmowy.
    if (deps.users.count() <= 1) return listWithFail(request, reply, 'Nie można usunąć ostatniego konta panelu.');
    if (id === request.adminUserId) return listWithFail(request, reply, 'Nie można usunąć własnego konta.');

    deps.users.delete(id);
    deps.sessions.destroyForUser(id);
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'uzytkownik.usuniecie',
      target: `uzytkownik:${id}`, meta: { login: user.login }, ip: request.ip,
    });
    render.flash(request, 'ok', `Użytkownik ${user.login} usunięty. Jego sesje zostały zamknięte.`);
    return reply.redirect('/uzytkownicy', 302);
  });

  app.post<{ Params: { id: string } }>('/uzytkownicy/:id/reset-2fa', async (request, reply) => {
    const id = Number(request.params.id);
    const user = deps.users.findById(id);
    if (!user) return reply.callNotFound();

    deps.users.resetTotp(id);
    deps.sessions.destroyForUser(id);
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'uzytkownik.reset_2fa',
      target: `uzytkownik:${id}`, meta: { login: user.login }, ip: request.ip,
    });
    // Reset własnego konta zamknął też tę sesję - komunikat nie ma już gdzie trafić.
    if (id === request.adminUserId) return reply.redirect('/zaloguj', 302);
    render.flash(request, 'ok', `Drugi składnik użytkownika ${user.login} wyłączony. `
      + 'Przy następnym logowaniu panel poprosi o włączenie go od nowa.');
    return reply.redirect('/uzytkownicy', 302);
  });

  type PasswordBody = { obecne?: string; nowe?: string; nowe2?: string };

  app.get('/haslo', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return render.page(request, { title: 'Zmiana hasła', active: null, body: passwordPage() });
  });

  app.post<{ Body: PasswordBody }>('/haslo', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const user = deps.users.findById(request.adminUserId!);
    if (!user) return reply.redirect('/zaloguj', 302);

    const fail = (message: string) => {
      reply.code(400);
      return render.page(request, { title: 'Zmiana hasła', active: null, body: passwordPage(message) });
    };

    const current = request.body?.obecne ?? '';
    const next = request.body?.nowe ?? '';
    if (!(await verifyPassword(user.passwordHash, current))) return fail('Obecne hasło nie pasuje.');
    if (next !== (request.body?.nowe2 ?? '')) return fail('Nowe hasła różnią się.');
    try {
      validatePassword(next);
    } catch (e) {
      if (e instanceof UserInputError) return fail(e.message);
      throw e;
    }

    deps.users.setPassword(user.id, await hashPassword(next));
    // Bieżąca sesja zostaje - osoba zmieniająca hasło nie ma powodu logować się od nowa.
    deps.sessions.destroyForUser(user.id, request.cookies[SESSION_COOKIE]);
    deps.audit.record({ actor: user.login, action: 'haslo.zmiana', ip: request.ip });
    render.flash(request, 'ok', 'Hasło zmienione.');
    return reply.redirect('/przeglad', 302);
  });
}
