import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Rekord końca katalogu ma 22 bajty plus komentarz do 65 535 bajtów. */
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 65_535;

/**
 * Czytnik na potrzeby getreport.aspx: jedno archiwum, jeden plik, metoda „store” albo
 * „deflate”. Bez zależności - biblioteki ZIP ciągną za sobą dziesiątki pakietów, a tu
 * potrzeba kilkudziesięciu linii. Nie obsługuje ZIP64 ani szyfrowania; raporty Plusa
 * ich nie używają.
 */
export function unzipFirstFile(archive: Buffer): { name: string; data: Buffer } {
  let eocd = -1;
  for (let i = archive.length - EOCD_MIN; i >= 0 && i >= archive.length - EOCD_SEARCH; i -= 1) {
    if (archive.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Odpowiedź nie jest archiwum ZIP.');

  const entries = archive.readUInt16LE(eocd + 10);
  const cdOffset = archive.readUInt32LE(eocd + 16);
  if (entries === 0 || cdOffset + 46 > archive.length || archive.readUInt32LE(cdOffset) !== CENTRAL) {
    throw new Error('Archiwum ZIP jest puste albo uszkodzone.');
  }

  const method = archive.readUInt16LE(cdOffset + 10);
  const compressedSize = archive.readUInt32LE(cdOffset + 20);
  const nameLength = archive.readUInt16LE(cdOffset + 28);
  const localOffset = archive.readUInt32LE(cdOffset + 42);
  const name = archive.subarray(cdOffset + 46, cdOffset + 46 + nameLength).toString('utf8');

  if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL) {
    throw new Error('Archiwum ZIP jest uszkodzone.');
  }
  const localName = archive.readUInt16LE(localOffset + 26);
  const localExtra = archive.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + localName + localExtra;
  const raw = archive.subarray(start, start + compressedSize);

  if (method === 0) return { name, data: Buffer.from(raw) };
  if (method === 8) return { name, data: inflateRawSync(raw) };
  throw new Error(`Nieobsługiwana metoda kompresji ZIP: ${method}`);
}
