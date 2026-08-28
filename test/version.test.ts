import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GATE_VERSION } from '../src/version.ts';

describe('GATE_VERSION', () => {
  it('jest numerem z package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(GATE_VERSION).toBe(pkg.version);
    expect(GATE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
