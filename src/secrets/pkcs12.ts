import forge from 'node-forge';

export class Pkcs12Error extends Error {
  constructor(reason: string) {
    super(`Nie udało się odczytać pliku .pfx: ${reason}`);
    this.name = 'Pkcs12Error';
  }
}

export interface CertBundle {
  certPem: string;
  keyPem: string;
  caPem: string | null;
  cn: string;
  organization: string | null;
  locality: string | null;
  country: string | null;
  issuerCn: string;
  /** Odcisk SHA-1 wielkimi literami, oktety rozdzielone dwukropkami. */
  fingerprintSha1: string;
  notBefore: Date;
  notAfter: Date;
  keyBits: number;
}

// Słownik OID-ów node-forge jest typowany jako mapa o dowolnych kluczach, więc
// przy noUncheckedIndexedAccess każdy odczyt daje `string | undefined`. Wyciągamy
// potrzebne identyfikatory raz, żeby nie powtarzać zawężenia w każdym wywołaniu.
const OID_CERT_BAG = forge.pki.oids.certBag!;
const OID_SHROUDED_KEY_BAG = forge.pki.oids.pkcs8ShroudedKeyBag!;
const OID_KEY_BAG = forge.pki.oids.keyBag!;

function field(attrs: forge.pki.CertificateField[], name: string): string | null {
  const found = attrs.find((a) => a.shortName === name);
  return typeof found?.value === 'string' ? found.value : null;
}

function fingerprint(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha1.create();
  md.update(der);
  return md.digest().toHex().toUpperCase().match(/.{2}/g)!.join(':');
}

export function readPkcs12(buffer: Buffer, passphrase: string): CertBundle {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(buffer.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Pkcs12Error(
      reason.toLowerCase().includes('mac') ? 'złe hasło do pliku' : 'plik nie jest poprawnym archiwum PKCS#12',
    );
  }

  const certBags = p12.getBags({ bagType: OID_CERT_BAG })[OID_CERT_BAG] ?? [];
  const keyBags =
    p12.getBags({ bagType: OID_SHROUDED_KEY_BAG })[OID_SHROUDED_KEY_BAG] ??
    p12.getBags({ bagType: OID_KEY_BAG })[OID_KEY_BAG] ??
    [];

  const certs = certBags
    .map((b: forge.pkcs12.Bag) => b.cert)
    .filter((c): c is forge.pki.Certificate => Boolean(c));
  const key = keyBags[0]?.key;
  if (certBags.length === 0) throw new Pkcs12Error('archiwum nie zawiera certyfikatu');
  if (keyBags.length === 0) throw new Pkcs12Error('archiwum nie zawiera klucza prywatnego');
  // node-forge rozpakowuje wyłącznie materiał RSA; certyfikat ECDSA i klucz EC zostają
  // w workach jako null. Bez tego sprawdzenia użytkownik widziałby „brak certyfikatu”.
  if (certs.length === 0 || !key || !('n' in key) || !('e' in key)) {
    throw new Pkcs12Error('certyfikat albo klucz nie jest RSA, a tylko RSA obsługują Multiinfo i bramka');
  }

  // Certyfikat kliencki to ten, którego klucz publiczny pasuje do klucza prywatnego.
  // Pozostałe certyfikaty tworzą ścieżkę certyfikacyjną.
  const publicPem = forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey(
    (key as forge.pki.rsa.PrivateKey).n,
    (key as forge.pki.rsa.PrivateKey).e,
  ));
  const leaf =
    certs.find((c: forge.pki.Certificate) => forge.pki.publicKeyToPem(c.publicKey) === publicPem) ?? certs[0]!;
  const chain = certs.filter((c: forge.pki.Certificate) => c !== leaf);

  return {
    certPem: forge.pki.certificateToPem(leaf),
    keyPem: forge.pki.privateKeyToPem(key),
    caPem:
      chain.length > 0
        ? chain.map((c: forge.pki.Certificate) => forge.pki.certificateToPem(c)).join('')
        : null,
    cn: field(leaf.subject.attributes, 'CN') ?? '',
    organization: field(leaf.subject.attributes, 'O'),
    locality: field(leaf.subject.attributes, 'L'),
    country: field(leaf.subject.attributes, 'C'),
    issuerCn: field(leaf.issuer.attributes, 'CN') ?? '',
    fingerprintSha1: fingerprint(leaf),
    notBefore: leaf.validity.notBefore,
    notAfter: leaf.validity.notAfter,
    keyBits: (key as forge.pki.rsa.PrivateKey).n.bitLength(),
  };
}
