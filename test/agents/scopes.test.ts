import { describe, expect, it } from 'vitest';
import { SCOPE_LABELS, needsWarning, normalizeScopes } from '../../src/agents/scopes.ts';

describe('zakresy', () => {
  it('etykiety zakresów w panelu', () => {
    expect(SCOPE_LABELS).toEqual({
      send: 'Wysyłka SMS-ów', send_group: 'Wysyłka do grup', read_sent: 'Odczyt wysłanych', campaigns: 'Wyniki kampanii',
      read_inbound: 'Odczyt odebranych', reply: 'Odpowiedź nadawcy',
    });
  });

  it('reply dokłada read_inbound i zgłasza to', () => expect(normalizeScopes(['reply'])).toEqual({ scopes: ['read_inbound', 'reply'], addedReadInbound: true }));

  it('normalizeScopes porządkuje zakresy i nie zgłasza dodania, gdy read_inbound już jest', () => {
    expect(normalizeScopes(['reply', 'send', 'read_inbound'])).toEqual({ scopes: ['send', 'read_inbound', 'reply'], addedReadInbound: false });
  });

  it('ostrzeżenie tylko dla send z read_inbound, nie dla send_group i reply', () => {
    expect(needsWarning(['send', 'read_inbound'])).toBe(true);
    expect(needsWarning(['send_group', 'read_inbound'])).toBe(false);
    expect(needsWarning(['read_inbound', 'reply'])).toBe(false);
    expect(needsWarning(['send', 'read_sent'])).toBe(false);
  });
});
