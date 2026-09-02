import { z } from 'zod';
import { RULE_OPS } from './conditions.ts';
import { isValidPath } from './paths.ts';

export type IntegrationKind = 'webhook_in' | 'webhook_out';
export const INTEGRATION_KINDS: IntegrationKind[] = ['webhook_in', 'webhook_out'];

export const OUTBOUND_EVENTS = ['message.received', 'message.sent', 'message.delivered', 'message.failed'] as const;
export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

const path = z.string().min(1).max(200).refine(isValidPath, 'nieprawidłowa ścieżka');

const conditionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('builder'), rules: z.array(z.object({ path, op: z.enum(RULE_OPS), value: z.string().max(500) })).max(20) }),
  z.object({ mode: z.literal('liquid'), expr: z.string().max(2000) }),
]);

const common = {
  condition: conditionSchema,
  throttle: z.object({ limit: z.number().int().min(1).max(1000), windowMinutes: z.number().int().min(1).max(1440) }),
  eventLogLimit: z.number().int().min(20).max(2000),
};

/** Nazwa nagłówka HTTP: token bez spacji i dwukropka. */
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

export const inboundConfigSchema = z.object({
  ...common,
  auth: z.object({
    header: z.object({ name: headerName, valueRef: z.string().min(1) }).optional(),
    basic: z.object({ user: z.string().min(1).max(200), passRef: z.string().min(1) }).optional(),
    sources: z.array(z.string().min(1).max(253)).max(50),
  }),
  to: z.object({ path: path.optional(), fallback: z.array(z.string().min(1)).max(50) }),
  ticketRefPath: path.optional(),
  eventIdPath: path.optional(),
  text: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('path'), path }),
    z.object({ mode: z.literal('liquid'), template: z.string().max(4000) }),
  ]),
  maxParts: z.number().int().min(1).max(9),
  overflow: z.enum(['truncate', 'reject']),
});
export type InboundConfig = z.infer<typeof inboundConfigSchema>;

export const outboundConfigSchema = z.object({
  ...common,
  events: z.array(z.enum(OUTBOUND_EVENTS)).min(1),
  url: z.string().url().max(2000),
  method: z.enum(['POST', 'PUT', 'PATCH']),
  headers: z.array(z.object({ name: headerName, value: z.string().max(2000).optional(), valueRef: z.string().optional() })).max(20),
  body: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('json'), template: z.string().max(8000) }),
    z.object({ mode: z.literal('form'), fields: z.array(z.object({ name: z.string().min(1).max(100), template: z.string().max(2000) })).max(30) }),
    /** Surowy tekst (ntfy i podobne). */
    z.object({ mode: z.literal('text'), template: z.string().max(8000) }),
  ]),
  responseRefPath: path.optional(),
  sign: z.boolean(),
});
export type OutboundConfig = z.infer<typeof outboundConfigSchema>;

export type IntegrationConfig = InboundConfig | OutboundConfig;
export type IntegrationSecrets = Record<string, string>;

export function parseConfig(kind: 'webhook_in', raw: unknown): InboundConfig;
export function parseConfig(kind: 'webhook_out', raw: unknown): OutboundConfig;
export function parseConfig(kind: IntegrationKind, raw: unknown): IntegrationConfig;
export function parseConfig(kind: IntegrationKind, raw: unknown): IntegrationConfig {
  return kind === 'webhook_in' ? inboundConfigSchema.parse(raw) : outboundConfigSchema.parse(raw);
}

export const defaultInboundConfig = (): InboundConfig => ({
  condition: { mode: 'builder', rules: [] }, throttle: { limit: 10, windowMinutes: 10 }, eventLogLimit: 200,
  auth: { sources: [] }, to: { fallback: [] }, text: { mode: 'liquid', template: '' }, maxParts: 1, overflow: 'truncate',
});

/** Adres jest pusty celowo: formularz go wymaga, a schemat zod odrzuca - domyślna wychodząca nie przejdzie bez adresu. */
export const defaultOutboundConfig = (): OutboundConfig => ({
  condition: { mode: 'builder', rules: [] }, throttle: { limit: 10, windowMinutes: 10 }, eventLogLimit: 200,
  events: ['message.received'], url: '', method: 'POST', headers: [], body: { mode: 'json', template: '' }, sign: false,
});
