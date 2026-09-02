import type { IntegrationKind } from '../config.ts';
import { custom } from './custom.ts';
import { freescout } from './freescout.ts';
import { freshdesk } from './freshdesk.ts';
import { grafana } from './grafana.ts';
import { homeAssistant } from './home-assistant.ts';
import { ntfy } from './ntfy.ts';
import { prostyJson } from './prosty-json.ts';
import { slack } from './slack.ts';
import { teams } from './teams.ts';
import type { Preset } from './types.ts';
import { uptimeKuma } from './uptime-kuma.ts';
import { zabbix } from './zabbix.ts';

export type { Preset, PresetField, PresetSecret } from './types.ts';

/** Kolejność z tabeli specu; „Własne” zawsze na końcu kafelków. */
export const PRESETS: Preset[] = [prostyJson, uptimeKuma, grafana, zabbix, homeAssistant, freescout, freshdesk, slack, teams, ntfy, custom];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

export const presetsFor = (kind: IntegrationKind): Preset[] => PRESETS.filter((p) => p.kinds.includes(kind));
