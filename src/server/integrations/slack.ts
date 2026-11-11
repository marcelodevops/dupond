import { safeRequest } from '../egress.js';
import { coordinator, isMaskedSecret } from '../coordinator.js';

export const SLACK_ALLOWED_HOSTS = ['hooks.slack.com'];

interface SlackDispatchResult {
  status: number;
  body: unknown;
}

/**
 * Real Slack Block Kit Webhook Dispatcher. Allowlist plus no-redirect: fetch
 * followed 3xx by default, so a genuine hooks.slack.com URL could bounce the
 * post (and its token) to any host. The wire view masks this credential, so
 * the UI can only ever post the mask back (or nothing): the server-held
 * webhook is authoritative, and a value the user actually typed is treated as
 * an override.
 */
export async function dispatchSlack(body: any): Promise<SlackDispatchResult> {
  const { webhookUrl, message, channel = '#engineering-sprint', task, eventType = 'status_update' } = body;

  const taskText = task ? `*${task.key}: ${task.title}*` : (message?.text || message || 'Dupond Sprint Notification');
  const priorityEmoji = task?.priority === 'critical' ? '🔴' : task?.priority === 'high' ? '🟠' : '🟢';

  // Construct Slack Block Kit layout
  const blockKitPayload = {
    channel,
    username: 'Dupond Orchestrator',
    icon_emoji: ':robot_face:',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `⚡ Dupond Orchestrator Telemetry Alert`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: taskText,
        },
      },
      ...(task ? [
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Status:*\n\`${task.status.toUpperCase()}\`` },
            { type: 'mrkdwn', text: `*Priority:*\n${priorityEmoji} ${task.priority.toUpperCase()}` },
            { type: 'mrkdwn', text: `*Effort:*\n${task.spentHours || 0}/${task.estimatedHours || 6}h` },
            { type: 'mrkdwn', text: `*Assignee:*\n<@${task.assignedAgentId}>` },
          ],
        },
      ] : []),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Event: *${eventType}* • Timestamp: <!date^${Math.floor(Date.now() / 1000)}^{date_num} {time_secs}|${new Date().toLocaleTimeString()}>`,
          },
        ],
      },
    ],
  };

  let realDispatchSuccess = false;
  let realHttpStatus: number | null = null;
  let responseBody: string | null = null;

  const submittedWebhook = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
  const targetWebhook = !submittedWebhook || isMaskedSecret(submittedWebhook)
    ? coordinator.getIntegrationSecrets().slack.webhookUrl
    : submittedWebhook;

  if (targetWebhook && targetWebhook.startsWith('https://hooks.slack.com/')) {
    try {
      const slackResponse = await safeRequest(targetWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(blockKitPayload),
        allowedHosts: SLACK_ALLOWED_HOSTS,
        timeoutMs: 6000,
      });
      realDispatchSuccess = slackResponse.ok;
      realHttpStatus = slackResponse.status;
      responseBody = slackResponse.location
        ? `refused redirect to ${slackResponse.location}`
        : slackResponse.body;
    } catch (err: any) {
      console.warn('Real Slack webhook dispatch error:', err.message);
      responseBody = err.message;
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      dispatchedViaRealWebhook: realDispatchSuccess,
      httpStatus: realHttpStatus,
      responseBody,
      channel,
      payload: blockKitPayload,
      timestamp: new Date().toISOString(),
      messageId: `msg-${Date.now()}`,
    },
  };
}
