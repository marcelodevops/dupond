import { safeRequest } from '../egress.js';
import { coordinator, isMaskedSecret } from '../coordinator.js';

/** Jira Cloud only: keeps this endpoint from becoming a token-forwarding proxy. */
export const JIRA_ALLOWED_HOSTS = ['.atlassian.net'];

interface JiraSyncResult {
  status: number;
  body: unknown;
}

/**
 * Atlassian Jira Cloud REST integration. Credentials and destination come from
 * server-held config only. The body used to supply hostUrl + apiToken, which
 * let any caller point a Basic-auth token at an arbitrary origin — a
 * credential-smuggling oracle.
 */
export async function syncJiraTask(body: any, projectId?: string): Promise<JiraSyncResult> {
  const action = body?.action || 'sync_task';
  const task = body?.task;

  const jira = coordinator.getIntegrationSecrets(projectId).jira;
  const hostUrl = jira.hostUrl;
  const userEmail = jira.userEmail;
  let apiToken = jira.apiToken;

  // A UI form posts back the mask it was handed when the user did not retype
  // the token; accept a freshly typed value only as a replacement for a mask.
  const submitted = body?.apiToken;
  if (typeof submitted === 'string' && submitted.trim() !== '' && !isMaskedSecret(submitted)) {
    apiToken = submitted.trim();
  }

  if (!(hostUrl && userEmail && apiToken && !isMaskedSecret(apiToken))) {
    const projectKey = jira.projectKey || 'AEG';
    const defaultHost = (hostUrl || 'https://acme-enterprise.atlassian.net').replace(/\/+$/, '');
    const defaultKey = task?.key || `${projectKey}-101`;
    return {
      status: 200,
      body: {
        success: true,
        realJiraCall: false,
        action,
        jiraIssueId: defaultKey,
        issueUrl: `${defaultHost}/browse/${defaultKey}`,
        syncedAt: new Date().toISOString(),
        mappedStatus: task?.status === 'done' ? 'Closed' : task?.status === 'review' ? 'In Review' : 'In Progress',
        notice: 'Live Jira Cloud connector is ready. Save a real Atlassian user email, API token and *.atlassian.net host to create and transition live tickets.',
        fields: {
          summary: task?.title || 'Autonomous Task',
          assignee: task?.assignedAgentId || 'Dupond Bot',
          priority: task?.priority || 'Medium',
        },
      },
    };
  }

  const cleanHost = hostUrl.trim().replace(/\/+$/, '');
  const authHeader = `Basic ${Buffer.from(`${userEmail.trim()}:${apiToken.trim()}`).toString('base64')}`;
  const headers = { authorization: authHeader, accept: 'application/json' };

  // Real Jira Verification Probe
  if (action === 'verify') {
    const probe = await safeRequest(`${cleanHost}/rest/api/3/myself`, {
      method: 'GET',
      headers,
      allowedHosts: JIRA_ALLOWED_HOSTS,
      timeoutMs: 7000,
    });

    if (!probe.ok) {
      return {
        status: 200,
        body: {
          success: false,
          realJiraCall: true,
          statusCode: probe.status,
          error: `Jira authentication failed (${probe.status}): ${probe.body.slice(0, 200)}`,
        },
      };
    }

    const userData = JSON.parse(probe.body);
    return {
      status: 200,
      body: {
        success: true,
        realJiraCall: true,
        verified: true,
        displayName: userData.displayName,
        emailAddress: userData.emailAddress,
        accountType: userData.accountType,
        message: `Connected successfully to Jira Cloud as ${userData.displayName} (${userData.emailAddress})!`,
      },
    };
  }

  const summary = task?.title ? `[Dupond] ${task.key}: ${task.title}` : '[Dupond] Autonomous Task';
  const descriptionADF = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: task?.description || 'Autonomous sprint deliverable managed by Dupond Orchestrator.' }],
      },
    ],
  };

  const created = await safeRequest(`${cleanHost}/rest/api/3/issue`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      fields: {
        project: { key: body?.projectKey || jira.projectKey || 'AEG' },
        summary,
        description: descriptionADF,
        issuetype: { name: 'Task' },
      },
    }),
    allowedHosts: JIRA_ALLOWED_HOSTS,
    timeoutMs: 8000,
  });

  if (created.ok) {
    const createdData = JSON.parse(created.body);
    return {
      status: 200,
      body: {
        success: true,
        realJiraCall: true,
        jiraIssueId: createdData.key,
        issueUrl: `${cleanHost}/browse/${createdData.key}`,
        syncedAt: new Date().toISOString(),
        mappedStatus: task?.status === 'done' ? 'Closed' : task?.status === 'review' ? 'In Review' : 'In Progress',
        message: `Successfully synchronized task ${task?.key} to real Jira issue ${createdData.key}!`,
      },
    };
  }

  return {
    status: 200,
    body: {
      success: false,
      realJiraCall: true,
      statusCode: created.status,
      error: `Jira API returned HTTP ${created.status}: ${created.body.slice(0, 300)}`,
    },
  };
}
