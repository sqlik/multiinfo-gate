import type { ToolDef } from '../tools.ts';
import { campaignResultsTool, listCampaignsTool } from './campaigns.ts';
import { conversationTool, prepareConversationReplyTool } from './conversation.ts';
import { fileSendStatusTool, fileSummaryTool, openFileSendTool, prepareFileSmsTool, sendFileSmsTool, uploadFileRowsTool } from './file.ts';
import { listInboundTool, prepareRepliesTool, sendReplyTool } from './inbound.ts';
import { deliveryTraceTool, listMessagesTool, listPackagesTool, packageReportTool, packageStatusTool } from './read.ts';
import { cancelMessageTool, cancelPackageTool, prepareGroupSmsTool, prepareSmsTool, sendPreparedTool } from './send.ts';
import { connectionStatusTool } from './status.ts';

/** Narzędzia bramki w kolejności listy `tools/list`: „Co mogę?”, wysyłka, rozsyłka z pliku, odczyt wysłanych, kampanie, odebrane, rozmowa i odpowiedzi. */
export const TOOLS: readonly ToolDef[] = [
  connectionStatusTool,
  prepareSmsTool, prepareGroupSmsTool, sendPreparedTool, cancelMessageTool, cancelPackageTool,
  openFileSendTool, uploadFileRowsTool, fileSummaryTool, prepareFileSmsTool, sendFileSmsTool, fileSendStatusTool,
  listMessagesTool, listPackagesTool, deliveryTraceTool, packageStatusTool, packageReportTool,
  listCampaignsTool, campaignResultsTool,
  listInboundTool, conversationTool, prepareRepliesTool, prepareConversationReplyTool, sendReplyTool,
];
