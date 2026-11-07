import { z } from '../zod.ts';
import type { LinkRequest } from '../links/shortener.ts';

/**
 * Pola skracania wspólne dla `POST /v1/messages`, `POST /v1/packages` i akcji Power Automate.
 * Ustawienie klucza ma pierwszeństwo przed `shortenLinks`; odpowiedź zgłasza, że zostało zastosowane.
 */
export const linkFieldsSchema = {
  shortenLinks: z.boolean().optional(),
  campaign: z.string().trim().min(1).max(100).optional(),
  linkDomain: z.string().optional(),
  linkValidityDays: z.number().int().min(1).max(365).optional(),
};

export interface LinkFields {
  shortenLinks?: boolean | undefined; campaign?: string | undefined; linkDomain?: string | undefined; linkValidityDays?: number | undefined;
}

/** Pola żądania w postaci wejścia usługi skracania; pominięte pola nie trafiają do wyniku. */
export function linkRequest(fields: LinkFields): LinkRequest {
  return {
    ...(fields.shortenLinks !== undefined ? { shorten: fields.shortenLinks } : {}),
    ...(fields.campaign !== undefined ? { campaign: fields.campaign } : {}),
    ...(fields.linkDomain !== undefined ? { domain: fields.linkDomain } : {}),
    ...(fields.linkValidityDays !== undefined ? { validityDays: fields.linkValidityDays } : {}),
  };
}
