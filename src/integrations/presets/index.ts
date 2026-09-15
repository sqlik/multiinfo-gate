import type { IntegrationKind } from '../config.ts';
import { custom } from './custom.ts';
import { fakturownia } from './fakturownia.ts';
import { fakturowniaKlient } from './fakturownia-klient.ts';
import { freescout } from './freescout.ts';
import { freescoutZgloszenie } from './freescout-zgloszenie.ts';
import { freshdesk } from './freshdesk.ts';
import { freshdeskZgloszenie } from './freshdesk-zgloszenie.ts';
import { grafana } from './grafana.ts';
import { homeAssistant } from './home-assistant.ts';
import { n8n } from './n8n.ts';
import { ntfy } from './ntfy.ts';
import { prostyJson } from './prosty-json.ts';
import { slack } from './slack.ts';
import type { Preset } from './types.ts';
import { uptimeKuma } from './uptime-kuma.ts';
import { woocommerce } from './woocommerce.ts';
import { woocommerceKlient } from './woocommerce-klient.ts';
import { zabbix } from './zabbix.ts';

export type { Preset, PresetField, PresetSecret } from './types.ts';

/** Kolejność z tabeli specu; „Własne” zawsze na końcu kafelków. Teams czeka na potwierdzenie próbką (plik obok). */
export const PRESETS: Preset[] = [prostyJson, n8n, uptimeKuma, grafana, zabbix, woocommerce, woocommerceKlient, fakturownia, fakturowniaKlient, homeAssistant, freescoutZgloszenie, freescout, freshdeskZgloszenie, freshdesk, slack, ntfy, custom];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

export const presetsFor = (kind: IntegrationKind): Preset[] => PRESETS.filter((p) => p.kinds.includes(kind));
