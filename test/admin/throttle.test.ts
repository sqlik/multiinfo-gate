import { describe, expect, it } from 'vitest';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LoginThrottle } from '../../src/admin/throttle.ts';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

describe('LoginThrottle', () => {
  it('przepuszcza adres poniżej limitu nieudanych prób', () => {
    const c = clock();
    const throttle = new LoginThrottle(c.now);
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) throttle.fail('10.0.0.1');
    expect(throttle.allowed('10.0.0.1')).toBe(true);
  });

  it('blokuje adres po osiągnięciu limitu', () => {
    const c = clock();
    const throttle = new LoginThrottle(c.now);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) throttle.fail('10.0.0.1');
    expect(throttle.allowed('10.0.0.1')).toBe(false);
  });

  it('liczy adresy osobno', () => {
    const c = clock();
    const throttle = new LoginThrottle(c.now);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) throttle.fail('10.0.0.1');
    expect(throttle.allowed('10.0.0.2')).toBe(true);
  });

  it('zdejmuje blokadę po upływie okna od ostatniej nieudanej próby', () => {
    const c = clock();
    const throttle = new LoginThrottle(c.now);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) throttle.fail('10.0.0.1');
    c.tick(LOGIN_WINDOW_MS);
    expect(throttle.allowed('10.0.0.1')).toBe(false);
    c.tick(1);
    expect(throttle.allowed('10.0.0.1')).toBe(true);
  });

  it('próby rozrzucone dalej niż okno nie sumują się', () => {
    const c = clock();
    const throttle = new LoginThrottle(c.now);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      throttle.fail('10.0.0.1');
      c.tick(LOGIN_WINDOW_MS + 1);
    }
    expect(throttle.allowed('10.0.0.1')).toBe(true);
  });

  it('udane logowanie zeruje licznik', () => {
    const c = clock();
    const throttle = new LoginThrottle(c.now);
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) throttle.fail('10.0.0.1');
    throttle.reset('10.0.0.1');
    throttle.fail('10.0.0.1');
    expect(throttle.allowed('10.0.0.1')).toBe(true);
  });
});
