import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { M365AccountsRepo } from '../../src/store/m365-accounts.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';

const T0 = new Date('2026-11-04T09:00:00Z');
const T1 = new Date('2026-11-04T10:00:00Z');
const T2 = new Date('2026-11-04T11:00:00Z');
const TOKEN = 'token-odswiezania-0123456789';
const INPUT = { name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' };

let db: ReturnType<typeof openDatabase>;
let repo: M365AccountsRepo;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new M365AccountsRepo(db, randomBytes(32));
});

const connect = (id: number, at = T1) =>
  repo.connected(id, { refreshToken: TOKEN, address: 'alarmy@firma.pl', redirectUri: 'http://localhost:8081/m365/powrot', by: 'admin' }, at);

describe('M365AccountsRepo', () => {
  it('create zakłada konto w stanie new, bez adresu i bez tokenu', () => {
    const id = repo.create(INPUT, T0);
    expect(repo.get(id)).toEqual({
      id, name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: INPUT.clientId, redirectUri: null, address: null,
      state: 'new', errorCode: null, errorMessage: null, errorSince: null, notifiedAt: null,
      connectedAt: null, connectedBy: null, lastRefreshAt: null, createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
    });
    expect(repo.refreshToken(id)).toBeNull();
    expect(repo.list().map((r) => r.id)).toEqual([id]);
    expect(repo.get(id + 1)).toBeUndefined();
  });

  it('connected zapisuje token zaszyfrowany, adres, adres przekierowania i czyści błąd', () => {
    const id = repo.create(INPUT, T0);
    repo.failed(id, { state: 'error', code: null, message: 'brak połączenia' }, T0);
    connect(id);
    expect(repo.get(id)).toMatchObject({
      state: 'connected', address: 'alarmy@firma.pl', redirectUri: 'http://localhost:8081/m365/powrot',
      connectedAt: T1.toISOString(), connectedBy: 'admin', lastRefreshAt: T1.toISOString(),
      errorCode: null, errorMessage: null, errorSince: null, notifiedAt: null,
    });
    expect(JSON.stringify(db.prepare('SELECT * FROM m365_accounts').get())).not.toContain(TOKEN);
    expect(repo.refreshToken(id)).toBe(TOKEN);
  });

  it('refreshed zastępuje token, przywraca connected i czyści błąd razem z notified_at', () => {
    const id = repo.create(INPUT, T0);
    connect(id);
    repo.failed(id, { state: 'error', code: null, message: 'przekroczony czas' }, T1);
    repo.markNotified(id, T1);
    repo.refreshed(id, 'nowy-token', T2);
    expect(repo.refreshToken(id)).toBe('nowy-token');
    expect(repo.get(id)).toMatchObject({ state: 'connected', lastRefreshAt: T2.toISOString(), errorSince: null, notifiedAt: null, errorMessage: null });
  });

  it('failed dwa razy zachowuje pierwsze errorSince, a kod i komunikat bierze z ostatniego', () => {
    const id = repo.create(INPUT, T0);
    connect(id);
    repo.failed(id, { state: 'error', code: null, message: 'przekroczony czas' }, T1);
    repo.failed(id, { state: 'needs_login', code: '50173', message: 'Microsoft odrzucił token' }, T2);
    expect(repo.get(id)).toMatchObject({ state: 'needs_login', errorCode: '50173', errorMessage: 'Microsoft odrzucił token', errorSince: T1.toISOString() });
  });

  it('markNotified zapisuje czas powiadomienia', () => {
    const id = repo.create(INPUT, T0);
    repo.failed(id, { state: 'needs_login', code: '50173', message: 'x' }, T1);
    repo.markNotified(id, T2);
    expect(repo.get(id)!.notifiedAt).toBe(T2.toISOString());
  });

  it('update ze zmienionym identyfikatorem aplikacji kasuje token i daje new', () => {
    const id = repo.create(INPUT, T0);
    connect(id);
    repo.update(id, { ...INPUT, clientId: '99999999-2222-3333-4444-555555555555' }, T2);
    expect(repo.refreshToken(id)).toBeNull();
    expect(repo.get(id)).toMatchObject({ state: 'new', clientId: '99999999-2222-3333-4444-555555555555', connectedAt: null, updatedAt: T2.toISOString() });
  });

  it('update ze zmienionym katalogiem kasuje token i daje new', () => {
    const id = repo.create(INPUT, T0);
    connect(id);
    repo.update(id, { ...INPUT, tenant: 'inna.onmicrosoft.com' }, T2);
    expect(repo.refreshToken(id)).toBeNull();
    expect(repo.get(id)!.state).toBe('new');
  });

  it('update ze zmienioną tylko nazwą zostawia połączenie i token', () => {
    const id = repo.create(INPUT, T0);
    connect(id);
    repo.update(id, { ...INPUT, name: 'Dyspozytornia' }, T2);
    expect(repo.refreshToken(id)).toBe(TOKEN);
    expect(repo.get(id)).toMatchObject({ name: 'Dyspozytornia', state: 'connected', updatedAt: T2.toISOString() });
  });

  it('setAddress zmienia adres skrzynki', () => {
    const id = repo.create(INPUT, T0);
    connect(id);
    repo.setAddress(id, 'dyspozytornia@firma.pl', T2);
    expect(repo.get(id)).toMatchObject({ address: 'dyspozytornia@firma.pl', updatedAt: T2.toISOString() });
  });

  it('disconnect kasuje token i błąd, konto wraca do new z zachowanym adresem', () => {
    const id = repo.create(INPUT, T0);
    connect(id);
    repo.failed(id, { state: 'needs_login', code: '50173', message: 'x' }, T1);
    repo.disconnect(id, T2);
    expect(repo.refreshToken(id)).toBeNull();
    expect(repo.get(id)).toMatchObject({ state: 'new', address: 'alarmy@firma.pl', errorCode: null, errorSince: null, connectedAt: null, connectedBy: null });
  });

  it('remove usuwa konto, a konta wskazanego w ustawieniach SMTP usunąć nie można', () => {
    const a = repo.create(INPUT, T0);
    const b = repo.create({ ...INPUT, name: 'Biuro handlowe' }, T0);
    repo.remove(a);
    expect(repo.get(a)).toBeUndefined();
    const notifications = new NotificationsRepo(db, randomBytes(32));
    notifications.saveSmtp({
      host: 'smtp.office365.com', port: 587, security: 'starttls', user: 'alarmy@firma.pl', fromAddress: 'alarmy@firma.pl', fromName: 'Multiinfo Gate',
      recipients: ['it@firma.pl'], instanceName: 'bramka', panelUrl: null, authMode: 'm365', m365AccountId: b,
    }, T0);
    expect(() => repo.remove(b)).toThrow();
    expect(repo.get(b)).toBeDefined();
  });
});
