import { describe, expect, it } from 'vitest';
import { unzipFirstFile } from '../../src/multiinfo/zip.ts';
import { makeZip } from '../helpers/zip.ts';

describe('unzipFirstFile', () => {
  it('rozpakowuje plik skompresowany deflate', () => {
    const out = unzipFirstFile(makeZip('raport.csv', Buffer.from('a;b\n1;2\n'), 'deflate'));
    expect(out.name).toBe('raport.csv');
    expect(out.data.toString()).toBe('a;b\n1;2\n');
  });

  it('rozpakowuje plik zapisany bez kompresji', () => {
    expect(unzipFirstFile(makeZip('r.txt', Buffer.from('x'), 'store')).data.toString()).toBe('x');
  });

  it('radzi sobie z większym plikiem i polskimi znakami', () => {
    const content = Buffer.from('9001;48601135134;21;20260826120000;Zażółć\n'.repeat(5000), 'utf8');
    expect(unzipFirstFile(makeZip('raport.csv', content)).data.equals(content)).toBe(true);
  });

  it('odrzuca dane, które nie są archiwum', () => {
    expect(() => unzipFirstFile(Buffer.from('-62\nBrak raportu'))).toThrow(/archiwum/);
    expect(() => unzipFirstFile(Buffer.alloc(0))).toThrow(/archiwum/);
  });

  it('odrzuca archiwum z nieobsługiwaną metodą kompresji', () => {
    const zip = makeZip('r.txt', Buffer.from('x'), 'store');
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt16LE(12, cdOffset + 10);
    expect(() => unzipFirstFile(zip)).toThrow(/metoda kompresji/);
  });
});
