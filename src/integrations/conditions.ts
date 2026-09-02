import { readPath } from './paths.ts';
import type { TemplateEngine } from './templates.ts';

export const RULE_OPS = ['eq', 'ne', 'contains', 'starts', 'regex', 'exists', 'missing', 'gt', 'lt'] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export interface Rule { path: string; op: RuleOp; value: string }

export type ConditionConfig = { mode: 'builder'; rules: Rule[] } | { mode: 'liquid'; expr: string };

const LABELS: Record<RuleOp, string> = {
  eq: 'równe', ne: 'różne od', contains: 'zawiera', starts: 'zaczyna się od', regex: 'pasuje do wyrażenia',
  exists: 'istnieje', missing: 'nie istnieje', gt: 'większe niż', lt: 'mniejsze niż',
};
export const ruleOpLabel = (op: RuleOp): string => LABELS[op];

/** Wartość z ładunku jako tekst do porównań; obiekty i tablice jako JSON, brak jako pusty ciąg. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ruleMatches(rule: Rule, payload: unknown): boolean {
  const value = readPath(payload, rule.path);
  switch (rule.op) {
    case 'exists': return value !== undefined && value !== null;
    case 'missing': return value === undefined || value === null;
    case 'eq': return asText(value) === rule.value;
    case 'ne': return asText(value) !== rule.value;
    case 'contains': return asText(value).includes(rule.value);
    case 'starts': return asText(value).startsWith(rule.value);
    case 'regex': {
      try {
        return new RegExp(rule.value, 'u').test(asText(value));
      } catch {
        return false;
      }
    }
    case 'gt':
    case 'lt': {
      const text = asText(value);
      const left = Number(text);
      const right = Number(rule.value);
      // Porównanie liczbowe tylko, gdy obie strony są liczbami; inaczej tekstowe.
      const numeric = text !== '' && !Number.isNaN(left) && rule.value !== '' && !Number.isNaN(right);
      if (numeric) return rule.op === 'gt' ? left > right : left < right;
      return rule.op === 'gt' ? text > rule.value : text < rule.value;
    }
  }
}

/** Wynik trybu zaawansowanego: pusty ciąg, `false` i `0` to „nie wysyłaj”. */
const FALSY = new Set(['', 'false', '0', 'nil', 'null']);

/** Czy zdarzenie ma iść dalej. Reguły konstruktora czytają z `context.p`; wyrażenie Liquid widzi cały kontekst. */
export function matches(condition: ConditionConfig, context: Record<string, unknown>, engine: TemplateEngine): boolean {
  if (condition.mode === 'builder') return condition.rules.every((rule) => ruleMatches(rule, context.p));
  return !FALSY.has(engine.render(condition.expr, context).trim().toLowerCase());
}
