import { describe, expect, it } from 'vitest';
import { FlashStore } from '../../src/admin/flash.ts';

describe('FlashStore', () => {
  it('oddaje komunikat dokładnie raz', () => {
    const store = new FlashStore();
    store.put('t1', { tone: 'ok', text: 'Konto zapisane.' });
    expect(store.take('t1')).toEqual({ tone: 'ok', text: 'Konto zapisane.' });
    expect(store.take('t1')).toBeNull();
  });

  it('bez wpisu zwraca null', () => {
    expect(new FlashStore().take('nie-ma')).toBeNull();
  });

  it('nowy komunikat dla tej samej sesji zastępuje poprzedni', () => {
    const store = new FlashStore();
    store.put('t1', { tone: 'ok', text: 'pierwszy' });
    store.put('t1', { tone: 'fail', text: 'drugi' });
    expect(store.take('t1')?.text).toBe('drugi');
  });

  it('nie miesza sesji', () => {
    const store = new FlashStore();
    store.put('a', { tone: 'ok', text: 'dla a' });
    expect(store.take('b')).toBeNull();
    expect(store.take('a')?.text).toBe('dla a');
  });
});
