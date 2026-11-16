/**
 * Adres bramki z ustawienia „Adres bramki dla aplikacji”, bez końcowego ukośnika. Jest identyfikatorem wydawcy
 * i zasobu w metadanych, dlatego nie wyprowadzamy go z nagłówka Host.
 */
export function gatewayBase(apiUrl: string | null): string | null {
  const trimmed = apiUrl?.trim().replace(/\/+$/, '') ?? '';
  return trimmed === '' ? null : trimmed;
}

/** RFC 9728. Bez `scopes_supported`: zakresy agenta nadaje administrator w panelu, a nie aplikacja przez OAuth. */
export function protectedResourceMetadata(base: string): Record<string, unknown> {
  return { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], resource_name: 'Multiinfo Gate' };
}

/** RFC 8414: wyłącznie kod autoryzacji z PKCE S256 i klienci publiczni. */
export function authorizationServerMetadata(base: string): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}
