import type { IntegrationKind } from '../config.ts';
import { custom } from './custom.ts';
import { freescout } from './freescout.ts';
import { freescoutZgloszenie } from './freescout-zgloszenie.ts';
import { freshdesk } from './freshdesk.ts';
import { freshdeskZgloszenie } from './freshdesk-zgloszenie.ts';
import { grafana } from './grafana.ts';
import { ntfy } from './ntfy.ts';
import { prostyJson } from './prosty-json.ts';
import type { Preset } from './types.ts';
import { uptimeKuma } from './uptime-kuma.ts';
import { zabbix } from './zabbix.ts';

export type { Preset, PresetField, PresetSecret } from './types.ts';

/** Kolejność z tabeli specu; „Własne” zawsze na końcu kafelków. Home Assistant, Slack i Teams czekają na potwierdzenie próbką (pliki obok). */
export const PRESETS: Preset[] = [prostyJson, uptimeKuma, grafana, zabbix, freescoutZgloszenie, freescout, freshdeskZgloszenie, freshdesk, ntfy, custom];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

export const presetsFor = (kind: IntegrationKind): Preset[] => PRESETS.filter((p) => p.kinds.includes(kind));
