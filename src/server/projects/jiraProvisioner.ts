import crypto from 'crypto';
import { safeRequest } from '../egress.js';
import { ProjectStore, ProjectApiError, defaultProjectStore } from './projectStore.js';
import {
  JiraProvisionRequest,
  JiraProvisionResult,
} from '../../types/projectContract.js';

const JIRA_ALLOWED_HOSTS = ['.atlassian.net'];

export interface JiraRequestSpec {
  hostUrl: string;
  path: string; // begins with /rest/...
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  auth: { userEmail: string; apiToken: string };
}

export interface JiraResponse {
  status: number;
  body: any;
}

/**
 * Injectable so tests run against local fixtures instead of real Jira sites.
 * The default transport goes through safeRequest (host allowlist, public-IP
 * filter, DNS-rebinding pinning, no redirects, size cap).
 */
export interface JiraTransport {
  request(spec: JiraRequestSpec): Promise<JiraResponse>;
}

export const defaultJiraTransport: JiraTransport = {
  async request(spec) {
    const res = await safeRequest(`${spec.hostUrl.replace(/\/$/, '')}${spec.path}`, {
      method: spec.method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${spec.auth.userEmail}:${spec.auth.apiToken}`).toString('base64')}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      allowedHosts: JIRA_ALLOWED_HOSTS,
      timeoutMs: 15000,
    });
    let parsed: any = null;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      parsed = { raw: res.body };
    }
    return { status: res.status, body: parsed };
  },
};

/**
 * Exactly-creatable configurations only: template keys are validated against
 * this matrix, taken verbatim from the Jira Cloud REST v3 Create-project
 * documentation. Anything outside it is refused before a remote call.
 */
export const SUPPORTED_JIRA_TEMPLATES: Record<string, string[]> = {
  business: [
    'com.atlassian.jira-core-project-templates:jira-core-simplified-content-management',
    'com.atlassian.jira-core-project-templates:jira-core-simplified-document-approval',
    'com.atlassian.jira-core-project-templates:jira-core-simplified-lead-tracking',
    'com.atlassian.jira-core-project-templates:jira-core-simplified-process-control',
    'com.atlassian.jira-core-project-templates:jira-core-simplified-procurement',
    'com.atlassian.jira-core-project-templates:jira-core-simplified-project-management',
    'com.atlassian.jira-core-project-templates:jira-core-simplified-recruitment',
    'com.atlassian.jira-core-project-templates:jira-core-simplified-task-tracking',
  ],
  software: [
    'com.pyxis.greenhopper.jira:gh-simplified-agility-kanban',
    'com.pyxis.greenhopper.jira:gh-simplified-agility-scrum',
    'com.pyxis.greenhopper.jira:gh-simplified-basic',
    'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic',
    'com.pyxis.greenhopper.jira:gh-simplified-scrum-classic',
  ],
  service_desk: [
    'com.atlassian.servicedesk:simplified-it-service-management',
    'com.atlassian.servicedesk:simplified-external-service-desk',
    'com.atlassian.servicedesk:simplified-hr-service-desk',
    'com.atlassian.servicedesk:simplified-facilities-service-desk',
    'com.atlassian.servicedesk:simplified-finance-service-desk',
    'com.atlassian.servicedesk:simplified-legal-service-desk',
    'com.atlassian.servicedesk:simplified-marketing-service-desk',
    'com.atlassian.servicedesk:simplified-sales-service-desk',
    'com.atlassian.servicedesk:simplified-analytics-service-desk',
    'com.atlassian.servicedesk:simplified-design-service-desk',
    'com.atlassian.servicedesk:company-managed-blank-service-project',
    'com.atlassian.servicedesk:company-managed-general-service-project',
    'com.atlassian.servicedesk:team-managed-general-service-project',
  ],
  customer_service: [
    'com.atlassian.jcs:customer-service-management',
  ],
};

function fingerprintRequest(req: JiraProvisionRequest): string {
  const remoteRelevant = {
    mode: req.mode,
    createProject: req.createProject,
    projectKey: req.projectKey,
    epicKey: req.epicKey,
    createEpic: req.createEpic,
  };
  return crypto.createHash('sha256').update(JSON.stringify(remoteRelevant)).digest('hex');
}

function upstreamError(res: JiraResponse): { message: string; errorJson: any } {
  const msgs = res.body?.errorMessages;
  const errors = res.body?.errors;
  const message =
    (Array.isArray(msgs) && msgs.join('; ')) ||
    (errors && typeof errors === 'object' && JSON.stringify(errors)) ||
    (typeof res.body?.message === 'string' && res.body.message) ||
    `Jira responded ${res.status}`;
  return { message, errorJson: res.body ?? { status: res.status } };
}

const NON_IDEMPOTENCY_NOTE =
  'Jira provides no server-side idempotency token for project/issue creation. Duplicate creation is prevented by a persisted operation record plus a reconcile lookup of the remote resource before any create; a crash between "remote accepted" and "outcome persisted" can still leave an already-created resource, which reconciliation adopts (status reconciled) rather than duplicating. At-most-once is therefore not guaranteed; outcome honesty is.';

export class JiraProvisioner {
  private store: ProjectStore;
  private transport: JiraTransport;

  constructor(store: ProjectStore = defaultProjectStore, transport: JiraTransport = defaultJiraTransport) {
    this.store = store;
    this.transport = transport;
  }

  public async provision(args: {
    projectId: string;
    request: JiraProvisionRequest;
    actor: string;
    operationId?: string;
  }): Promise<{ httpStatus: number; result: JiraProvisionResult }> {
    const { projectId, request, actor } = args;
    const project = this.store.getProject(projectId);
    if (!project) {
      throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found.`);
    }
    if (project.status === 'archived') {
      throw new ProjectApiError(403, 'PROJECT_ARCHIVED', `Project ${projectId} is archived; provisioning is not allowed.`);
    }
    const mode = request.mode as JiraProvisionRequest['mode'];
    if (!['link_existing', 'create_project', 'create_epic', 'none'].includes(mode)) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', `Unknown provisioning mode "${mode}".`);
    }

    const operationId = args.operationId || request.operationId || `jop-${crypto.randomUUID()}`;
    const fingerprint = fingerprintRequest(request);
    const begun = this.store.beginOperation({ projectId, operationId, mode, requestFingerprint: fingerprint });

    if (begun.kind === 'conflict') {
      throw new ProjectApiError(
        409,
        'INVALID_REQUEST',
        `Operation ${operationId} already exists with different content or project. Use a fresh operationId.`,
      );
    }
    if (begun.kind === 'replay' && begun.record.status !== 'started') {
      const persisted = begun.record.result_json ? JSON.parse(begun.record.result_json) : null;
      return {
        httpStatus: 200,
        result: {
          ...persisted,
          status: 'replayed',
          note: `Replayed persisted outcome of operation ${operationId} (${begun.record.status}); no remote call made. ${NON_IDEMPOTENCY_NOTE}`,
        } as JiraProvisionResult,
      };
    }

    const jira = project.jira || {};

    // 'none' never touches the remote.
    if (mode === 'none') {
      return this.finalize(operationId, {
        httpStatus: 200,
        result: {
          projectId,
          operationId,
          mode,
          status: 'no_change',
          connectionId: null,
          projectKey: null,
          epicKey: null,
          note: 'Local Jira link cleared; no remote resource was created, modified, or deleted.',
        },
      }, projectId, actor, { clearLink: true });
    }

    // Resolve credentials server-side.
    let connectionId: string | null = null;
    if (request.connectionId) {
      connectionId = request.connectionId;
    } else if (request.connection) {
      const forbidden = ['apiToken', 'token', 'password', 'pat'].filter(
        (k) => (request.connection as any)[k] !== undefined && k !== 'apiToken',
      );
      if (forbidden.length) {
        throw new ProjectApiError(400, 'CREDENTIAL_IN_BODY', `Unsupported credential field(s): ${forbidden.join(', ')}`);
      }
      connectionId = this.store.saveJiraConnection(
        projectId,
        {
          hostUrl: request.connection.hostUrl,
          userEmail: request.connection.userEmail,
          apiToken: request.connection.apiToken,
          existingConnectionId: jira.connectionId || undefined,
        },
        actor,
      );
    } else if (jira.connectionId) {
      connectionId = jira.connectionId;
    }
    if (!connectionId) {
      throw new ProjectApiError(400, 'CONNECTION_NOT_FOUND', 'Provisioning requires connectionId, connection inputs, or a project connection already on file.');
    }
    const secret = this.store.getJiraConnectionSecret(connectionId, projectId);
    if (!secret) {
      throw new ProjectApiError(400, 'CONNECTION_NOT_FOUND', `Connection ${connectionId} does not belong to project ${projectId}.`);
    }
    const auth = { userEmail: secret.userEmail, apiToken: secret.apiToken };
    const hostUrl = secret.hostUrl;

    if (mode === 'link_existing') {
      return this.linkExisting(operationId, projectId, connectionId, hostUrl, auth, request, actor);
    }
    if (mode === 'create_project') {
      if (request.confirmRemoteCreation !== true) {
        throw new ProjectApiError(
          403,
          'REMOTE_CONFIRMATION_REQUIRED',
          'create_project writes a new project to the remote Jira site and requires confirmRemoteCreation=true.',
        );
      }
      return this.createProject(operationId, projectId, connectionId, hostUrl, auth, request, actor);
    }
    // create_epic
    if (request.confirmRemoteCreation !== true) {
      throw new ProjectApiError(
        403,
        'REMOTE_CONFIRMATION_REQUIRED',
        'create_epic writes a new issue to the remote Jira site and requires confirmRemoteCreation=true.',
      );
    }
    return this.createEpic(operationId, projectId, connectionId, hostUrl, auth, request, actor);
  }

  private finalize(
    operationId: string,
    outcome: { httpStatus: number; result: JiraProvisionResult },
    projectId: string,
    actor: string,
    link?: { connectionId?: string | null; projectKey?: string | null; epicKey?: string | null; state?: 'linked' | 'provisioned' | 'failed'; clearLink?: boolean },
  ): { httpStatus: number; result: JiraProvisionResult } {
    const status =
      outcome.result.status === 'no_change' ? 'no_change' :
      outcome.result.status === 'reconciled' ? 'reconciled' :
      outcome.httpStatus >= 200 && outcome.httpStatus < 300 ? 'succeeded' : 'failed';

    this.store.transact(() => {
      this.store.finishOperation(operationId, {
        status: status as any,
        resultJson: JSON.stringify(outcome.result),
        remoteKey: outcome.result.projectKey ?? outcome.result.epicKey ?? null,
        errorJson: outcome.result.error ? JSON.stringify(outcome.result.error) : null,
      });
      if (link?.clearLink) {
        this.store.clearJiraLink(projectId);
      } else if (link && link.state !== 'failed') {
        this.store.applyJiraLink(projectId, {
          connectionId: link.connectionId,
          projectKey: link.projectKey ?? null,
          epicKey: link.epicKey ?? null,
          state: link.state || 'linked',
        });
      }
      this.store.audit({
        projectId,
        eventType: 'JIRA_PROVISION_OUTCOME',
        actor,
        details: {
          operationId,
          mode: outcome.result.mode,
          status,
          projectKey: outcome.result.projectKey || null,
          epicKey: outcome.result.epicKey || null,
          error: outcome.result.error || null,
        },
      });
    });
    return outcome;
  }

  private async linkExisting(
    operationId: string,
    projectId: string,
    connectionId: string,
    hostUrl: string,
    auth: { userEmail: string; apiToken: string },
    request: JiraProvisionRequest,
    actor: string,
  ) {
    const projectKey = (request.projectKey || '').trim();
    if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey)) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'projectKey must be a Jira project key: 2..10 characters, letters/digits/underscore, starting with a letter.');
    }
    const res = await this.transport.request({ hostUrl, path: `/rest/api/3/project/${encodeURIComponent(projectKey)}`, method: 'GET', auth });
    if (res.status === 404) {
      return this.failOutcome(operationId, projectId, request.mode, connectionId,
        { code: 'JIRA_UNREACHABLE', httpStatus: 404, message: `Project ${projectKey} does not exist on ${hostUrl} (or is not visible to this account).` },
        404, actor, 'link_existing does not create remote resources; create one with create_project instead.');
    }
    if (res.status === 401 || res.status === 403) {
      return this.failOutcome(operationId, projectId, request.mode, connectionId,
        { code: 'JIRA_PERMISSION_INSUFFICIENT', httpStatus: res.status, message: `The Jira account cannot browse project ${projectKey}; token lacks read access.`, requiredPermissions: ['Browse Projects (project permission)'] },
        403, actor);
    }
    if (res.status < 200 || res.status >= 300) {
      const { message, errorJson } = upstreamError(res);
      return this.failOutcome(operationId, projectId, request.mode, connectionId,
        { code: 'JIRA_UNREACHABLE', httpStatus: res.status, message }, 502, actor, undefined, errorJson);
    }

    let epicKey = request.epicKey?.trim() || null;
    if (epicKey) {
      const epicRes = await this.transport.request({ hostUrl, path: `/rest/api/3/issue/${encodeURIComponent(epicKey)}`, method: 'GET', auth });
      if (epicRes.status !== 200) {
        return this.failOutcome(operationId, projectId, request.mode, connectionId,
          { code: 'JIRA_UNREACHABLE', httpStatus: epicRes.status, message: `Epic ${epicKey} could not be read from ${hostUrl} (status ${epicRes.status}); it was not linked.` },
          400, actor);
      }
      const fields = epicRes.body?.fields || {};
      const issueTypeName = fields.issuetype?.name || '';
      const isEpic = issueTypeName.toLowerCase() === 'epic' || fields.custom_epic_color_1 !== undefined;
      if (!isEpic) {
        return this.failOutcome(operationId, projectId, request.mode, connectionId,
          { code: 'INVALID_REQUEST', message: `${epicKey} is issue type "${issueTypeName || 'unknown'}", not an Epic.` },
          400, actor);
      }
    }

    return this.finalize(operationId, {
      httpStatus: 200,
      result: {
        projectId,
        operationId,
        mode: 'link_existing',
        status: 'succeeded',
        connectionId,
        projectKey,
        epicKey,
        note: 'Validated by read-only probes; no remote write performed.',
      },
    }, projectId, actor, { connectionId, projectKey, epicKey, state: 'linked' });
  }

  private async createProject(
    operationId: string,
    projectId: string,
    connectionId: string,
    hostUrl: string,
    auth: { userEmail: string; apiToken: string },
    request: JiraProvisionRequest,
    actor: string,
  ) {
    const cp = request.createProject;
    if (!cp) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'create_project requires the createProject block (key, name, projectTypeKey, projectTemplateKey, leadAccountId).');
    }
    if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(cp.key || '')) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'createProject.key must be 2..10 uppercase letters/digits/underscore, starting with a letter.');
    }
    if (!cp.name || cp.name.length > 80) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'createProject.name is required (max 80 characters).');
    }
    if (!cp.leadAccountId) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'createProject.leadAccountId is required — the official API deprecated "lead" and requires an account id (GET /rest/api/3/users/userpicker or /rest/api/3/search/user can find it).');
    }
    const allowed = SUPPORTED_JIRA_TEMPLATES[cp.projectTypeKey];
    if (!allowed) {
      throw new ProjectApiError(400, 'JIRA_TEMPLATE_UNSUPPORTED', `projectTypeKey "${cp.projectTypeKey}" is not supported. Allowed: ${Object.keys(SUPPORTED_JIRA_TEMPLATES).join(', ')}.`);
    }
    if (!allowed.includes(cp.projectTemplateKey)) {
      throw new ProjectApiError(
        400,
        'JIRA_TEMPLATE_UNSUPPORTED',
        `projectTemplateKey "${cp.projectTemplateKey}" is not an officially creatable template for type "${cp.projectTypeKey}". Supported: ${allowed.join(', ')}`,
      );
    }

    // Reconcile-before-create: adopt an existing project with this key rather
    // than duplicating it (covers retry after a lost response).
    const probe = await this.transport.request({ hostUrl, path: `/rest/api/3/project/${encodeURIComponent(cp.key)}`, method: 'GET', auth });
    if (probe.status === 200 && probe.body?.key) {
      return this.finalize(operationId, {
        httpStatus: 200,
        result: {
          projectId,
          operationId,
          mode: 'create_project',
          status: 'reconciled',
          connectionId,
          projectKey: probe.body.key,
          epicKey: null,
          note: `Project ${cp.key} already exists on ${hostUrl} (id ${probe.body.id ?? 'unknown'}); linked it instead of creating a duplicate. ${NON_IDEMPOTENCY_NOTE}`,
        },
      } as any, projectId, actor, { connectionId, projectKey: probe.body.key, state: 'provisioned' });
    }

    const res = await this.transport.request({
      hostUrl,
      path: '/rest/api/3/project',
      method: 'POST',
      auth,
      body: {
        key: cp.key,
        name: cp.name,
        projectTypeKey: cp.projectTypeKey,
        projectTemplateKey: cp.projectTemplateKey,
        leadAccountId: cp.leadAccountId,
        ...(cp.description ? { description: cp.description } : {}),
      },
    });

    if (res.status === 403) {
      return this.failOutcome(operationId, projectId, 'create_project', connectionId,
        {
          code: 'JIRA_PERMISSION_INSUFFICIENT',
          httpStatus: 403,
          message: 'Jira refused project creation. Creating projects via REST requires the Administer Jira global permission (classic OAuth scope manage:jira-configuration; granular write:project:jira).',
          requiredPermissions: ['Administer Jira (global permission)'],
        }, 403, actor);
    }
    if (res.status !== 201 && res.status !== 200) {
      const { message, errorJson } = upstreamError(res);
      return this.failOutcome(operationId, projectId, 'create_project', connectionId,
        { code: 'JIRA_UNREACHABLE', httpStatus: res.status, message: `Project creation failed: ${message}` }, 502, actor, undefined, errorJson);
    }

    return this.finalize(operationId, {
      httpStatus: 200,
      result: {
        projectId,
        operationId,
        mode: 'create_project',
        status: 'succeeded',
        connectionId,
        projectKey: res.body?.key || cp.key,
        epicKey: null,
        note: `Created Jira project ${res.body?.key || cp.key} (id ${res.body?.id ?? 'unknown'}). ${NON_IDEMPOTENCY_NOTE}`,
      },
    } as any, projectId, actor, { connectionId, projectKey: res.body?.key || cp.key, state: 'provisioned' });
  }

  private async createEpic(
    operationId: string,
    projectId: string,
    connectionId: string,
    hostUrl: string,
    auth: { userEmail: string; apiToken: string },
    request: JiraProvisionRequest,
    actor: string,
  ) {
    const projectKey = (request.projectKey || '').trim();
    const summary = request.createEpic?.summary?.trim();
    if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey)) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'create_epic requires a valid projectKey of the existing Jira project.');
    }
    if (!summary) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'createEpic.summary is required.');
    }

    // Verify the Epic issue type actually exists for this project before
    // writing — only correctly-creatable configurations are attempted.
    const projRes = await this.transport.request({ hostUrl, path: `/rest/api/3/project/${encodeURIComponent(projectKey)}`, method: 'GET', auth });
    if (projRes.status !== 200) {
      return this.failOutcome(operationId, projectId, 'create_epic', connectionId,
        { code: 'JIRA_UNREACHABLE', httpStatus: projRes.status, message: `Jira project ${projectKey} could not be read (status ${projRes.status}). Link it first or use create_project.` },
        projRes.status === 404 ? 404 : 502, actor);
    }
    const issueTypes: any[] = projRes.body?.issueTypes || [];
    const epicType = issueTypes.find((t: any) => String(t.name).toLowerCase() === 'epic');
    if (!epicType) {
      return this.failOutcome(operationId, projectId, 'create_epic', connectionId,
        { code: 'JIRA_TEMPLATE_UNSUPPORTED', message: `Project ${projectKey} has no Epic issue type, so an epic cannot be created there. Supported issue types: ${issueTypes.map((t: any) => t.name).join(', ') || 'none visible'}.` },
        400, actor);
    }

    // Reconcile: an epic with this exact summary already in the project means a
    // previous attempt landed (or someone made it) — adopt instead of duplicating.
    const jql = `project = ${projectKey} AND issuetype = Epic AND summary = ${JSON.stringify(summary)}`;
    const search = await this.transport.request({
      hostUrl,
      path: `/rest/api/3/search/jira?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=5`,
      method: 'GET',
      auth,
    });
    const existingIssues: any[] = search.status === 200 ? search.body?.issues || [] : [];
    if (existingIssues.length > 0) {
      return this.finalize(operationId, {
        httpStatus: 200,
        result: {
          projectId,
          operationId,
          mode: 'create_epic',
          status: 'reconciled',
          connectionId,
          projectKey,
          epicKey: existingIssues[0].key,
          note: `Epic "${summary}" already exists in ${projectKey} as ${existingIssues[0].key}; linked it instead of creating a duplicate. ${NON_IDEMPOTENCY_NOTE}`,
        },
      } as any, projectId, actor, { connectionId, projectKey, epicKey: existingIssues[0].key, state: 'provisioned' });
    }

    const adfDescription = request.createEpic?.description
      ? {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: request.createEpic.description }] }],
        }
      : undefined;

    const res = await this.transport.request({
      hostUrl,
      path: '/rest/api/3/issue',
      method: 'POST',
      auth,
      body: {
        fields: {
          project: { key: projectKey },
          issuetype: { id: String(epicType.id) },
          summary,
          ...(adfDescription ? { description: adfDescription } : {}),
        },
      },
    });

    if (res.status === 401 || res.status === 403) {
      return this.failOutcome(operationId, projectId, 'create_epic', connectionId,
        { code: 'JIRA_PERMISSION_INSUFFICIENT', httpStatus: res.status, message: 'The Jira account cannot create issues in this project.', requiredPermissions: ['Create Issues (project permission)'] },
        403, actor);
    }
    if (res.status !== 201 && res.status !== 200) {
      const { message, errorJson } = upstreamError(res);
      return this.failOutcome(operationId, projectId, 'create_epic', connectionId,
        { code: 'JIRA_UNREACHABLE', httpStatus: res.status, message: `Epic creation failed: ${message}` }, 502, actor, undefined, errorJson);
    }

    const epicKey = res.body?.key || null;
    return this.finalize(operationId, {
      httpStatus: 200,
      result: {
        projectId,
        operationId,
        mode: 'create_epic',
        status: 'succeeded',
        connectionId,
        projectKey,
        epicKey,
        note: `Created epic ${epicKey} in ${projectKey}. ${NON_IDEMPOTENCY_NOTE}`,
      },
    } as any, projectId, actor, { connectionId, projectKey, epicKey, state: 'provisioned' });
  }

  private failOutcome(
    operationId: string,
    projectId: string,
    mode: string,
    connectionId: string | null,
    error: { code: string; httpStatus?: number; message: string; requiredPermissions?: string[] },
    httpStatus: number,
    actor: string,
    note?: string,
    _errorJson?: any,
  ) {
    return this.finalize(operationId, {
      httpStatus,
      result: {
        projectId,
        operationId,
        mode: mode as any,
        status: 'failed',
        connectionId,
        error,
        ...(note ? { note } : {}),
      },
    }, projectId, actor, undefined);
  }
}

export const defaultJiraProvisioner = new JiraProvisioner();
