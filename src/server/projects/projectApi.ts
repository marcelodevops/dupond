import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { ProjectStore, ProjectApiError, defaultProjectStore } from './projectStore.js';
import { JiraProvisioner, defaultJiraProvisioner } from './jiraProvisioner.js';
import { PROJECT_CONTEXT_HEADER, DEFAULT_PROJECT_ID } from '../../types/projectContract.js';

const RepositorySchema = z
  .object({
    repoUrl: z.string().max(1000).optional(),
    localPath: z.string().max(1000).optional(),
    defaultBranch: z.string().max(200).optional(),
    targetDirectory: z.string().max(500).optional(),
    localWriteMode: z.enum(['worktree', 'direct_write', 'git_branch', 'patch_export']).optional(),
    branchPrefix: z.string().max(200).optional(),
    deliveryMode: z.enum(['pull_request', 'branch_push', 'local_artifacts']).optional(),
    slug: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(1000).optional(),
    defaultBaseBranch: z.string().min(1).max(200).optional(),
  })
  .strict();

const PreferencesSchema = z
  .object({
    workerProvider: z.string().min(1).max(60).optional(),
    workerModel: z.string().min(1).max(120).optional(),
    requireApprovalByDefault: z.boolean().optional(),
    defaultProvider: z.string().min(1).max(60).optional(),
    defaultModel: z.string().min(1).max(120).optional(),
  })
  .strict();

const CreateProjectSchema = z
  .object({
    id: z.string().min(2).max(120).optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    repository: RepositorySchema.optional(),
    preferences: PreferencesSchema.optional(),
    agentPreferences: PreferencesSchema.optional(),
    jira: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const UpdateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    repository: RepositorySchema.optional(),
    jira: z
      .object({
        connectionId: z.string().nullable().optional(),
        projectKey: z.string().max(20).nullable().optional(),
        epicKey: z.string().max(30).nullable().optional(),
      })
      .strict(),
    preferences: PreferencesSchema.optional(),
    agentPreferences: PreferencesSchema.optional(),
  })
  .strict();

const ResetSchema = z.object({
  scopes: z.array(z.enum(['runs', 'evidence', 'deliveries', 'worktrees', 'artifacts'])).min(1).optional(),
  confirm: z.literal(true).optional(),
  confirmProjectName: z.string().min(1).optional(),
  scope: z.object({
    wipeTasks: z.boolean(),
    wipeCycles: z.boolean(),
    wipeWorktrees: z.boolean(),
    preserveRemoteGit: z.literal(true),
    preserveRemoteJira: z.literal(true),
  }).optional(),
}).strict();

const ConnectionInputSchema = z
  .object({
    hostUrl: z.string().url().max(300),
    userEmail: z.string().email().max(200),
    apiToken: z.string().min(8).max(200).optional(),
  })
  .strict();

const ProvisionSchema = z
  .object({
    mode: z.enum(['link_existing', 'create_project', 'create_epic', 'none']),
    connectionId: z.string().max(100).optional(),
    connectionRef: z.string().max(100).optional(),
    connection: ConnectionInputSchema.optional(),
    createProject: z
      .object({
        key: z.string().regex(/^[A-Z][A-Z0-9_]{1,9}$/),
        name: z.string().min(1).max(80),
        projectTypeKey: z.enum(['business', 'software', 'service_desk', 'customer_service']),
        projectTemplateKey: z.string().min(1).max(200),
        leadAccountId: z.string().min(1).max(100),
        description: z.string().max(2000).optional(),
      })
      .strict()
      .optional(),
    projectKey: z.string().max(20).optional(),
    epicKey: z.string().max(30).optional(),
    createEpic: z
      .object({
        summary: z.string().min(1).max(255),
        description: z.string().max(5000).optional(),
      })
      .strict()
      .optional(),
    confirmRemoteCreation: z.boolean().optional(),
    operationId: z.string().max(120).optional(),
  })
  .strict()
  .refine((r) => (r.connectionId ? !r.connection : true), {
    message: 'Provide either connectionId or connection inputs, not both.',
  });

const PROJECT_ID_SHAPE = /^[a-z0-9][a-z0-9_-]{1,119}$/i;

export function parseProjectContextHeader(req: Request): string | null {
  const raw = req.header(PROJECT_CONTEXT_HEADER);
  if (raw === undefined || raw === null || (Array.isArray(raw) ? raw[0] : raw).trim() === '') return null;
  const value = (Array.isArray(raw) ? raw[0] : raw).trim();
  if (value.length > 120 || !PROJECT_ID_SHAPE.test(value)) {
    throw new ProjectApiError(400, 'INVALID_REQUEST', `Malformed ${PROJECT_CONTEXT_HEADER} header. Expected a project id such as "${DEFAULT_PROJECT_ID}" or "proj-<uuid>".`);
  }
  return value;
}

function fail(res: Response, err: any): void {
  if (err instanceof ProjectApiError) {
    res.status(err.httpStatus).json({
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }
  if (err instanceof z.ZodError) {
    const hasCredentialField = err.issues.some((i) => ['apiToken', 'token', 'password', 'pat'].includes(String(i.path[i.path.length - 1])));
    res.status(400).json({
      error: `Invalid request: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      code: hasCredentialField ? 'CREDENTIAL_IN_BODY' : 'INVALID_REQUEST',
    });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: 'Request body must be valid JSON.', code: 'INVALID_REQUEST' });
    return;
  }
  res.status(500).json({ error: err?.message || 'Internal error', code: 'INTERNAL' });
}

export interface ProjectRouterDeps {
  store?: ProjectStore;
  provisioner?: JiraProvisioner;
}

export function createProjectRouter(deps: ProjectRouterDeps = {}): Router {
  const store = deps.store || defaultProjectStore;
  const router = Router();

  const projectContext = (req: Request): string => {
    const ctx = parseProjectContextHeader(req);
    if (ctx && !store.getProject(ctx)) {
      throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', `Project context ${ctx} does not exist.`);
    }
    return ctx || DEFAULT_PROJECT_ID;
  };

  router.get('/projects', (req: Request, res: Response) => {
    try {
      const includeArchived = req.query.includeArchived !== 'false';
      res.json(store.listProjects({ includeArchived }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/projects', (req: Request, res: Response) => {
    try {
      const body = CreateProjectSchema.parse(req.body ?? {});
      const project = store.createProject({
        id: body.id,
        name: body.name,
        description: body.description,
        repository: body.repository,
        preferences: (body.preferences || body.agentPreferences) as any,
        actor: 'api',
      });
      res.status(201).json(project);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/projects/:projectId', (req: Request, res: Response) => {
    try {
      const ctx = parseProjectContextHeader(req);
      if (ctx && ctx !== req.params.projectId) {
        throw new ProjectApiError(403, 'PROJECT_CONTEXT_MISMATCH', `Path project ${req.params.projectId} does not match ${PROJECT_CONTEXT_HEADER} context ${ctx}.`);
      }
      const project = store.getProject(req.params.projectId);
      if (!project) {
        throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', `Project ${req.params.projectId} not found.`);
      }
      // Archived projects stay readable: history is preserved for inspection.
      res.json(project);
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/projects/:projectId', (req: Request, res: Response) => {
    try {
      const ctx = projectContext(req);
      if (ctx !== req.params.projectId) {
        throw new ProjectApiError(403, 'PROJECT_CONTEXT_MISMATCH', `Path project ${req.params.projectId} does not match ${PROJECT_CONTEXT_HEADER} context ${ctx}.`);
      }
      const body = UpdateProjectSchema.parse(req.body ?? {});
      const project = store.updateProject(
        req.params.projectId,
        { ...body, preferences: body.preferences || body.agentPreferences } as any,
        'api',
      );
      res.json(project);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/projects/:projectId/archive', (req: Request, res: Response) => {
    try {
      const ctx = projectContext(req);
      if (ctx !== req.params.projectId) {
        throw new ProjectApiError(403, 'PROJECT_CONTEXT_MISMATCH', `Path project ${req.params.projectId} does not match ${PROJECT_CONTEXT_HEADER} context ${ctx}.`);
      }
      const project = store.archiveProject(req.params.projectId, 'api');
      res.json({
        projectId: project.id,
        status: 'archived',
        archivedAt: project.archivedAt || new Date().toISOString(),
        message: 'Project successfully archived.',
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/projects/:projectId/reset', (req: Request, res: Response) => {
    try {
      const ctx = projectContext(req);
      if (ctx !== req.params.projectId) {
        throw new ProjectApiError(403, 'PROJECT_CONTEXT_MISMATCH', `Path project ${req.params.projectId} does not match ${PROJECT_CONTEXT_HEADER} context ${ctx}.`);
      }
      const project = store.getProject(req.params.projectId);
      if (!project) {
        throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', `Project ${req.params.projectId} not found.`);
      }
      const body = ResetSchema.parse(req.body ?? {});
      if (body.confirmProjectName && body.confirmProjectName !== project.name) {
        throw new ProjectApiError(409, 'INVALID_REQUEST', 'Project name confirmation does not match.');
      }
      const scopes = body.scopes || [
        ...(body.scope?.wipeTasks ? ['runs', 'evidence', 'deliveries'] as const : []),
        ...(body.scope?.wipeCycles ? ['runs'] as const : []),
        ...(body.scope?.wipeWorktrees ? ['worktrees'] as const : []),
      ];
      if (!body.confirm && !body.confirmProjectName) {
        throw new ProjectApiError(400, 'INVALID_REQUEST', 'Reset requires explicit confirmation.');
      }
      const result = store.resetProject(req.params.projectId, Array.from(new Set(scopes)), 'api');
      res.json({
        projectId: result.projectId,
        resetAt: new Date().toISOString(),
        clearedTasksCount: result.cleared.runs,
        clearedCyclesCount: result.cleared.runs,
        clearedWorktreesCount: result.cleared.worktrees,
        message: 'Workspace successfully reset.',
        details: result,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/projects/:projectId/jira/provision', async (req: Request, res: Response) => {
    try {
      const ctx = projectContext(req);
      if (ctx !== req.params.projectId) {
        throw new ProjectApiError(403, 'PROJECT_CONTEXT_MISMATCH', `Path project ${req.params.projectId} does not match ${PROJECT_CONTEXT_HEADER} context ${ctx}.`);
      }
      const body = ProvisionSchema.parse(req.body ?? {});
      const provisioner = deps.provisioner || defaultJiraProvisioner;
      const { httpStatus, result } = await provisioner.provision({
        projectId: req.params.projectId,
        request: {
          ...body,
          connectionId: body.connectionId || body.connectionRef,
        } as any,
        actor: 'api',
      });

      router.get('/integrations/jira/metadata', (_req: Request, res: Response) => {
        res.json({
          templates: [],
          issueTypes: [{ id: 'epic', name: 'Epic', isEpic: true }],
          defaultTemplateKey: '',
          capabilities: {
            linkExisting: true,
            createProject: false,
            createEpic: false,
            reason: 'Remote Jira creation requires a configured server-held connection and supported capability.',
          },
        });
      });
      res.status(httpStatus).json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
