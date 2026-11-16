import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/api/openapi.ts';
import { buildPowerAutomateConnector } from '../../src/api/power-automate.ts';

/**
 * Kanon stylu: płaskie „nie ma” zastępuje precyzyjny czasownik, na przykład „Nie znaleziono rozsyłki”,
 * „Klucz nie obejmuje usługi”, „Grupa nie zawiera odbiorców” (Tomek 2026-11-16, także w API i konektorze).
 */
const FLAT = /\b[Nn]ie ma\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.(ts|js)$/.test(e.name) ? [path] : [];
  });
}

describe('komunikaty błędów dla ludzi', () => {
  it('ApiError, AgentError, toolError i komunikaty panelu o usługach i nadpisach bez „nie ma”', () => {
    const src = new URL('../../src', import.meta.url).pathname;
    const found = sourceFiles(src).flatMap((file) => readFileSync(file, 'utf8').split('\n')
      .map((line, i) => ({ where: `${file.slice(src.length + 1)}:${i + 1}`, line }))
      .filter(({ line }) => /new ApiError\(|new AgentError\(|toolError\(|error: `|return `\$\{name\}/.test(line) && FLAT.test(line)));
    expect(found).toEqual([]);
  });

  it('opis API i plik konektora Power Automate bez „nie ma”', () => {
    const openapi = JSON.stringify(buildOpenApiDocument());
    const connector = JSON.stringify(buildPowerAutomateConnector('https://sms.firma.pl'));
    expect(openapi.match(new RegExp(`.{0,60}${FLAT.source}.{0,60}`, 'g'))).toBeNull();
    expect(connector.match(new RegExp(`.{0,60}${FLAT.source}.{0,60}`, 'g'))).toBeNull();
  });
});
