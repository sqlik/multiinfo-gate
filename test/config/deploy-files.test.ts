import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.ts';
import { buildLinksServer } from '../../src/links/server.ts';
import { DomainChecks } from '../../src/links/domain-checks.ts';
import { redirectFixture } from '../links/redirect-fixture.ts';

/**
 * Pliki wdrożenia a kod bramki: port przekierowań, pytanie Caddy o certyfikat na żądanie
 * i nagłówki, po których serwer przekierowań rozpoznaje domenę. Składnię plików sprawdza
 * `docker compose config` i `caddy validate` przy próbie w Dockerze.
 */
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const LINKS_PORT = loadEnv({ MIG_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }, {}).linksPort;

describe('pliki wdrożenia skracacza', () => {
  it('domyślny port przekierowań to 8082 i tak go wymieniają pliki wdrożenia', () => {
    expect(LINKS_PORT).toBe(8082);
    expect(read('docker/docker-compose.yml')).toMatch(/^\s+MIG_LINKS_PORT: "8082"$/m);
    expect(read('proxmox/install/multiinfogate-install.sh')).toMatch(/^MIG_LINKS_PORT=8082$/m);
    expect(read('docker/Dockerfile')).toMatch(/^EXPOSE 8080 8081 8082$/m);
  });

  it('Caddy pyta bramkę o domenę pod adresem, który serwer przekierowań obsługuje', async () => {
    const caddyfile = read('docker/Caddyfile');
    const ask = /^\s*ask http:\/\/multiinfo-gate:(\d+)(\/\S+)$/m.exec(caddyfile);
    expect(ask).not.toBeNull();
    expect(Number(ask![1])).toBe(LINKS_PORT);
    const f = redirectFixture();
    const app = buildLinksServer({ ...f.deps, checks: new DomainChecks(), now: () => new Date() });
    try {
      const known = await app.inject({ method: 'GET', url: `${ask![2]}?domain=l.firma.pl` });
      expect(known.statusCode).toBe(200);
      const unknown = await app.inject({ method: 'GET', url: `${ask![2]}?domain=obca-domena.pl` });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('Caddy kieruje domeny skracacza z certyfikatem na żądanie do portu przekierowań, a HTTP na HTTPS', () => {
    const caddyfile = read('docker/Caddyfile');
    expect(caddyfile).toMatch(/^https:\/\/ \{\n\ttls \{\n\t\ton_demand\n\t\}\n\treverse_proxy multiinfo-gate:8082\n\}$/m);
    expect(caddyfile).toMatch(/^http:\/\/ \{\n\tredir https:\/\/\{host\}\{uri\} 308\n\}$/m);
    expect(caddyfile).toMatch(/^\{\$MIG_DOMENA\} \{\n\treverse_proxy multiinfo-gate:8080\n\}$/m);
  });

  it('port przekierowań trafia na hosta wyłącznie z docker-compose.nginx.yml', () => {
    expect(read('docker/docker-compose.yml')).not.toMatch(/:8082"/);
    expect(read('docker/docker-compose.nginx.yml')).toMatch(/^\s+- "127\.0\.0\.1:\$\{MIG_PORT_LINKOW:-8082\}:8082"$/m);
    for (const file of ['docker/docker-compose.caddy.yml', 'docker/docker-compose.traefik.yml', 'docker/docker-compose.traefik-linki.yml']) {
      expect(read(file), file).not.toMatch(/8082:/);
    }
  });

  it('Caddy i nginx w Dockerze domyślnie ufają adresowi klienta z sieci Dockera, Traefik ze wspólną siecią nie', () => {
    // Bez zaufania wszystkie wejścia liczą się na adres serwera pośredniczącego i limit 60 na minutę obejmuje całą bramkę.
    for (const file of ['docker/docker-compose.caddy.yml', 'docker/docker-compose.nginx.yml']) {
      expect(read(file), file).toMatch(/^\s+MIG_TRUSTED_PROXIES: \$\{MIG_TRUSTED_PROXIES:-172\.16\.0\.0\/12\}$/m);
    }
    // Sieć Traefika dzielą inne kontenery, które mogłyby podać dowolny adres klienta. Zaufanie ustawia administrator.
    for (const file of ['docker/docker-compose.traefik.yml', 'docker/docker-compose.traefik-linki.yml']) {
      expect(read(file), file).not.toMatch(/MIG_TRUSTED_PROXIES:/);
    }
  });

  it('nginx przekazuje domenę w nagłówku Host i adres odbiorcy w X-Forwarded-For do portu przekierowań', () => {
    const conf = read('docker/nginx/multiinfo-gate-linki.conf');
    expect(conf).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:8082;/);
    expect(conf).toMatch(/proxy_set_header Host \$host;/);
    expect(conf).toMatch(/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  });

  it('Traefik: router krótkich linków ma własną usługę na porcie przekierowań, a router API wskazuje swoją wprost', () => {
    const base = read('docker/docker-compose.traefik.yml');
    expect(base).toMatch(/traefik\.http\.routers\.multiinfo-gate\.service: multiinfo-gate$/m);
    const links = read('docker/docker-compose.traefik-linki.yml');
    expect(links).toMatch(/traefik\.http\.routers\.multiinfo-gate-linki\.rule: \$\{MIG_TRAEFIK_REGULA_LINKOW:\?/);
    expect(links).toMatch(/traefik\.http\.routers\.multiinfo-gate-linki\.service: multiinfo-gate-linki$/m);
    expect(links).toMatch(/traefik\.http\.services\.multiinfo-gate-linki\.loadbalancer\.server\.port: "8082"$/m);
  });
});
