import { createServer, type Server } from 'node:https';
import forge from 'node-forge';

export interface FakeRequest {
  path: string;
  method: string;
  params: Record<string, string>;
  /** Wszystkie wartości każdego parametru - dla parametrów powtarzanych, jak `dest` w package.aspx. */
  multi: Record<string, string[]>;
  clientCn: string | undefined;
  /** CN wystawcy certyfikatu klienta widziany przez serwer - dowód, że klient przysłał łańcuch. */
  clientIssuerCn: string | undefined;
}

export interface FakeMultiinfo {
  baseUrl: string;
  requests: FakeRequest[];
  /** Odpowiedź zwracana na kolejne żądanie; ustawiana przed każdym wywołaniem. */
  reply: (body: string | Buffer, statusCode?: number, contentType?: string) => void;
  /**
   * Odpowiedź liczona z żądania, także z opóźnieniem - do long pollingu. `null` wraca do `reply`.
   * Handler dostaje żądanie już zapisane w `requests`.
   */
  respond: (handler: ((req: FakeRequest) => string | Buffer | Promise<string | Buffer>) | null) => void;
  clientCertPem: string;
  clientKeyPem: string;
  /** Łańcuch certyfikatu klienta (CA pośrednie), jak z pliku .pfx. */
  caPem: string;
  /** CA serwera - u prawdziwego Multiinfo to publiczne CA z magazynu Node. */
  serverCaPem: string;
  close: () => Promise<void>;
}

function makeCert(
  cn: string,
  issuer?: { cert: forge.pki.Certificate; key: forge.pki.PrivateKey },
  isCa = !issuer,
) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1e9));
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ shortName: 'CN', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: isCa },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
  ]);
  cert.sign(issuer ? issuer.key : keys.privateKey, forge.md.sha256.create());
  return {
    cert,
    key: keys.privateKey,
    pem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/**
 * Uruchamia lokalny serwer HTTPS wymagający certyfikatu klienckiego.
 *
 * Topologia jak u prawdziwego Multiinfo: certyfikat serwera pochodzi z innego CA niż
 * certyfikat klienta, a klienta podpisuje CA pośrednie, którego serwer nie zna - ufa
 * tylko korzeniowi, więc pośrednie musi przyjść od klienta w łańcuchu.
 */
export async function startFakeMultiinfo(): Promise<FakeMultiinfo> {
  const serverCa = makeCert('Fake Server CA');
  const server = makeCert('localhost', { cert: serverCa.cert, key: serverCa.key });
  const clientRoot = makeCert('Fake Client Root CA');
  const clientIssuing = makeCert('Fake Client Issuing CA', { cert: clientRoot.cert, key: clientRoot.key }, true);
  const client = makeCert('firma_test', { cert: clientIssuing.cert, key: clientIssuing.key });

  const requests: FakeRequest[] = [];
  let body: string | Buffer = '0\n1';
  let statusCode = 200;
  let contentType = 'text/plain; charset=utf-8';
  let handler: ((req: FakeRequest) => string | Buffer | Promise<string | Buffer>) | null = null;

  const httpsServer: Server = createServer(
    { key: server.keyPem, cert: server.pem, ca: [clientRoot.pem], requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'https://localhost');
        const source = req.method === 'POST'
          ? new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
          : url.searchParams;
        const peer = (req.socket as {
          getPeerCertificate?: (detailed: boolean) => {
            subject?: { CN?: string };
            issuerCertificate?: { subject?: { CN?: string } };
          };
        }).getPeerCertificate?.(true);
        const entry: FakeRequest = {
          path: url.pathname,
          method: req.method ?? 'GET',
          params: Object.fromEntries(source.entries()),
          multi: Object.fromEntries([...new Set(source.keys())].map((k) => [k, source.getAll(k)])),
          clientCn: peer?.subject?.CN,
          clientIssuerCn: peer?.issuerCertificate?.subject?.CN,
        };
        requests.push(entry);
        const send = (b: string | Buffer) => {
          if (res.destroyed) return;
          res.writeHead(statusCode, { 'content-type': contentType });
          res.end(b);
        };
        if (handler === null) { send(body); return; }
        void Promise.resolve(handler(entry)).then(send);
      });
    },
  );

  await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  const address = httpsServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `https://localhost:${port}/Api61/`,
    requests,
    reply: (b, s = 200, c = 'text/plain; charset=utf-8') => { body = b; statusCode = s; contentType = c; handler = null; },
    respond: (h) => { handler = h; },
    clientCertPem: client.pem,
    clientKeyPem: client.keyPem,
    caPem: clientIssuing.pem,
    serverCaPem: serverCa.pem,
    close: () => new Promise((resolve) => { httpsServer.close(() => resolve()); }),
  };
}
