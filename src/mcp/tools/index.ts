import type { ToolDef } from '../tools.ts';
import { campaignResultsTool, listCampaignsTool } from './campaigns.ts';
import { listInboundTool, prepareRepliesTool, sendReplyTool } from './inbound.ts';
import { deliveryTraceTool, listMessagesTool, packageReportTool, packageStatusTool } from './read.ts';
import { cancelMessageTool, prepareGroupSmsTool, prepareSmsTool, sendPreparedTool } from './send.ts';
import { connectionStatusTool } from './status.ts';

/** Narzędzia bramki w kolejności listy `tools/list`: „Co mogę?”, wysyłka, odczyt wysłanych, kampanie, odebrane i odpowiedzi. */
export const TOOLS: readonly ToolDef[] = [
  connectionStatusTool,
  prepareSmsTool, prepareGroupSmsTool, sendPreparedTool, cancelMessageTool,
  listMessagesTool, deliveryTraceTool, packageStatusTool, packageReportTool,
  listCampaignsTool, campaignResultsTool,
  listInboundTool, prepareRepliesTool, sendReplyTool,
];
