import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useProject } from '../context/ProjectContext';
import { projectApi } from '../lib/projectApi';
import {
  Project,
  ProjectPreferences,
  ProjectRepositoryConfig,
  RepositoryVerificationResult,
} from '../types/projectContract';
import {
  X,
  Settings,
  GitBranch,
  Folder,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  RotateCw,
  Info,
  Save,
  Lock,
  Link2,
  Sliders,
} from 'lucide-react';

export type SettingsTab = 'general' | 'repository' | 'preferences';

interface ProjectSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (project: Project) => void;
  initialTab?: SettingsTab;
}

export const ProjectSettingsModal: React.FC<ProjectSettingsModalProps> = ({
  isOpen,
  onClose,
  onSaved,
  initialTab = 'general',
}) => {
  if (!isOpen) return null;
  return (
    <ProjectSettingsModalBody
      onClose={onClose}
      onSaved={onSaved}
      initialTab={initialTab}
    />
  );
};

const ProjectSettingsModalBody: React.FC<Omit<ProjectSettingsModalProps, 'isOpen'>> = ({
  onClose,
  onSaved,
  initialTab = 'general',
}) => {
  const { currentProject, updateProject } = useProject();

  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(
    () => currentProject?.id || null,
  );
  const [editingProjectName, setEditingProjectName] = useState<string>(
    () => currentProject?.name || currentProject?.id || '',
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // Identity Form Fields
  const [name, setName] = useState(() => currentProject?.name || '');
  const [description, setDescription] = useState(() => currentProject?.description || '');

  // Repository Form Fields
  const [localPath, setLocalPath] = useState(
    () => currentProject?.repository?.localPath || currentProject?.repository?.path || '',
  );
  const [repoUrl, setRepoUrl] = useState(() => currentProject?.repository?.repoUrl || '');
  const [defaultBranch, setDefaultBranch] = useState(
    () => currentProject?.repository?.defaultBranch || 'main',
  );
  const [localWriteMode, setLocalWriteMode] = useState<
    'worktree' | 'direct_write' | 'git_branch' | 'patch_export'
  >(() => currentProject?.repository?.localWriteMode || 'worktree');

  // Project-specific Preferences & Integration Mapping Fields
  const initialPrefs: ProjectPreferences =
    currentProject?.preferences || currentProject?.agentPreferences || {};
  const [defaultProvider, setDefaultProvider] = useState<string>(
    () => initialPrefs.defaultProvider || '',
  );
  const [defaultModel, setDefaultModel] = useState<string>(
    () => initialPrefs.defaultModel || '',
  );
  const [requireApprovalByDefault, setRequireApprovalByDefault] = useState<boolean>(
    () => Boolean(initialPrefs.requireApprovalByDefault),
  );
  const [jiraProjectKey, setJiraProjectKey] = useState<string>(
    () => currentProject?.jira?.projectKey || '',
  );
  const [jiraEpicKey, setJiraEpicKey] = useState<string>(
    () => currentProject?.jira?.epicKey || '',
  );

  // Verification Result
  const [verificationResult, setVerificationResult] = useState<RepositoryVerificationResult | null>(null);

  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const verifyEpochRef = useRef(0);
  const currentProjectIdRef = useRef<string | null>(currentProject?.id || null);
  currentProjectIdRef.current = currentProject?.id || null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadFromProject = useCallback((project: Project) => {
    setEditingProjectId(project.id);
    setEditingProjectName(project.name || project.id);
    setName(project.name || '');
    setDescription(project.description || '');
    const repo = project.repository || {};
    setLocalPath(repo.localPath || repo.path || '');
    setRepoUrl(repo.repoUrl || '');
    setDefaultBranch(repo.defaultBranch || 'main');
    setLocalWriteMode(repo.localWriteMode || 'worktree');
    const prefs: ProjectPreferences = project.preferences || project.agentPreferences || {};
    setDefaultProvider(prefs.defaultProvider || '');
    setDefaultModel(prefs.defaultModel || '');
    setRequireApprovalByDefault(Boolean(prefs.requireApprovalByDefault));
    setJiraProjectKey(project.jira?.projectKey || '');
    setJiraEpicKey(project.jira?.epicKey || '');
    setVerificationResult(null);
    setErrorBanner(null);
    setSuccessBanner(null);
    setShowDiscardConfirm(false);
  }, []);

  // Baseline values for dirty comparison (relative to the project currently loaded in the form)
  const baselineProject =
    currentProject && editingProjectId === currentProject.id ? currentProject : null;
  const origRepo = baselineProject?.repository || {};
  const origPrefs: ProjectPreferences = baselineProject?.preferences || baselineProject?.agentPreferences || {};
  const origJira = baselineProject?.jira || {};

  const isDirty = Boolean(editingProjectId) && (
    baselineProject === null ||
    name !== (baselineProject.name || '') ||
    description !== (baselineProject.description || '') ||
    localPath !== (origRepo.localPath || origRepo.path || '') ||
    repoUrl !== (origRepo.repoUrl || '') ||
    defaultBranch !== (origRepo.defaultBranch || 'main') ||
    localWriteMode !== (origRepo.localWriteMode || 'worktree') ||
    defaultProvider !== (origPrefs.defaultProvider || '') ||
    defaultModel !== (origPrefs.defaultModel || '') ||
    requireApprovalByDefault !== Boolean(origPrefs.requireApprovalByDefault) ||
    jiraProjectKey !== (origJira.projectKey || '') ||
    jiraEpicKey !== (origJira.epicKey || '')
  );

  const projectSwitchConflict =
    Boolean(currentProject && editingProjectId && currentProject.id !== editingProjectId);

  useEffect(() => {
    if (!currentProject) return;
    if (!editingProjectId) {
      loadFromProject(currentProject);
      return;
    }
    // If active project switched while form was clean, re-bind cleanly to the new project
    if (currentProject.id !== editingProjectId && !isDirty) {
      loadFromProject(currentProject);
    }
  }, [currentProject, editingProjectId, isDirty, loadFromProject]);

  const handleRequestClose = useCallback(() => {
    if (isSaving) return;
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    setShowDiscardConfirm(false);
    onClose();
  }, [isSaving, isDirty, onClose]);

  const handleConfirmDiscard = () => {
    if (currentProject) {
      loadFromProject(currentProject);
    }
    setShowDiscardConfirm(false);
    onClose();
  };

  const handleRequestCloseRef = useRef(handleRequestClose);
  handleRequestCloseRef.current = handleRequestClose;

  // Initial focus & focus restoration (runs only on mount/unmount of open modal)
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      previousFocusRef.current?.focus?.();
    };
  }, []);

  // Escape key handler (uses ref so typing/dirty/saving never steals focus)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleRequestCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // Invalidate verification result & in-flight responses whenever repository fields or project change
  const repoVerifyKey = `${editingProjectId || ''}::${localPath.trim()}::${defaultBranch.trim() || 'main'}::${repoUrl.trim()}::${localWriteMode}`;
  useEffect(() => {
    verifyEpochRef.current += 1;
    setVerificationResult(null);
    setIsVerifying(false);
  }, [repoVerifyKey]);

  const targetProject = currentProject;
  const isDefaultProject = (targetProject?.id || 'default') === 'default';
  const activeRunsCount = targetProject?.activeRunsCount || 0;
  const hasActiveRuns = activeRunsCount > 0;
  const isArchived = targetProject?.status === 'archived';

  const handleVerifyRepo = async () => {
    if (!targetProject || projectSwitchConflict) return;
    const verifyProjectId = targetProject.id;
    const epoch = ++verifyEpochRef.current;
    setIsVerifying(true);
    setErrorBanner(null);
    setVerificationResult(null);
    try {
      const candidate: ProjectRepositoryConfig = {
        localPath: localPath.trim(),
        repoUrl: repoUrl.trim() || undefined,
        defaultBranch: defaultBranch.trim() || 'main',
        localWriteMode,
      };
      const result = await projectApi.verifyRepository(verifyProjectId, candidate);
      if (
        !mountedRef.current ||
        verifyEpochRef.current !== epoch ||
        currentProjectIdRef.current !== verifyProjectId
      ) {
        return;
      }
      setVerificationResult(result);
    } catch (err: any) {
      if (
        !mountedRef.current ||
        verifyEpochRef.current !== epoch ||
        currentProjectIdRef.current !== verifyProjectId
      ) {
        return;
      }
      setVerificationResult({
        valid: false,
        localPathExists: false,
        isGitRepo: false,
        branchExists: false,
        writable: false,
        error: err.message || 'Repository verification failed.',
        details: [err.message || 'Unknown network or filesystem error'],
      });
    } finally {
      if (mountedRef.current && verifyEpochRef.current === epoch) {
        setIsVerifying(false);
      }
    }
  };

  const handleSave = async () => {
    if (!targetProject || !editingProjectId) return;
    if (targetProject.id !== editingProjectId) {
      setErrorBanner(
        `Active project changed to "${targetProject.name}". Discard or reload before saving so edits from "${editingProjectName}" are not applied to "${targetProject.name}".`,
      );
      return;
    }

    setIsSaving(true);
    setErrorBanner(null);
    setSuccessBanner(null);

    try {
      const repoChanged =
        localPath !== (origRepo.localPath || origRepo.path || '') ||
        repoUrl !== (origRepo.repoUrl || '') ||
        defaultBranch !== (origRepo.defaultBranch || 'main') ||
        localWriteMode !== (origRepo.localWriteMode || 'worktree');

      const prefsChanged =
        defaultProvider !== (origPrefs.defaultProvider || '') ||
        defaultModel !== (origPrefs.defaultModel || '') ||
        requireApprovalByDefault !== Boolean(origPrefs.requireApprovalByDefault);

      const jiraChanged =
        jiraProjectKey !== (origJira.projectKey || '') ||
        jiraEpicKey !== (origJira.epicKey || '');

      const patch: Record<string, any> = {};
      if (!isDefaultProject && name.trim() !== (targetProject.name || '')) {
        patch.name = name.trim();
      }
      if (description.trim() !== (targetProject.description || '')) {
        patch.description = description.trim();
      }
      if (repoChanged) {
        patch.repository = {
          localPath: localPath.trim() || undefined,
          repoUrl: repoUrl.trim() || undefined,
          defaultBranch: defaultBranch.trim() || 'main',
          localWriteMode,
        };
      }
      if (prefsChanged) {
        patch.preferences = {
          ...(defaultProvider ? { defaultProvider } : {}),
          ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
          requireApprovalByDefault,
        };
      }
      if (jiraChanged) {
        patch.jira = {
          projectKey: jiraProjectKey.trim() || null,
          epicKey: jiraEpicKey.trim() || null,
        };
      }

      const saveProjectId = editingProjectId;
      const updated = await updateProject(saveProjectId, patch);
      if (!mountedRef.current) return;
      if (currentProjectIdRef.current !== saveProjectId) {
        return;
      }
      loadFromProject(updated);
      setSuccessBanner(`Project settings saved for "${updated.name}".`);
      if (onSaved) onSaved(updated);
    } catch (err: any) {
      if (!mountedRef.current) return;
      setErrorBanner(err.message || 'Failed to update project settings.');
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleRequestClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        data-testid="project-settings-modal"
        className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full shadow-2xl overflow-hidden my-auto flex flex-col max-h-[92vh]"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-4 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-start space-x-2.5 min-w-0">
            <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 shrink-0">
              <Settings className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2
                id="project-settings-title"
                data-testid="project-settings-title"
                className="text-base font-bold text-white flex items-center gap-2 flex-wrap"
              >
                <span>Project Settings — {targetProject?.name || 'No Project Selected'}</span>
                {isDefaultProject && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                    Default Project
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Configuration scoped only to <strong className="text-slate-200">{targetProject?.name || 'this project'}</strong> (ID: <code className="text-indigo-300 font-mono">{targetProject?.id || '—'}</code>).
              </p>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={handleRequestClose}
            aria-label="Close Project Settings"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs Bar */}
        <div className="flex border-b border-slate-800 bg-slate-950/40 px-4 sm:px-6 gap-4 overflow-x-auto">
          <button
            type="button"
            data-testid="project-tab-general"
            onClick={() => setActiveTab('general')}
            className={`py-3 text-xs font-semibold border-b-2 whitespace-nowrap transition-colors ${
              activeTab === 'general'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            General Identity
          </button>
          <button
            type="button"
            data-testid="project-tab-repository"
            onClick={() => setActiveTab('repository')}
            className={`py-3 text-xs font-semibold border-b-2 whitespace-nowrap transition-colors ${
              activeTab === 'repository'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Repository &amp; Verification
          </button>
          <button
            type="button"
            data-testid="project-tab-preferences"
            onClick={() => setActiveTab('preferences')}
            className={`py-3 text-xs font-semibold border-b-2 whitespace-nowrap transition-colors ${
              activeTab === 'preferences'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Preferences &amp; Integrations
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-4 text-xs text-slate-300">
          {showDiscardConfirm && (
            <div
              data-testid="project-settings-discard-confirm"
              className="p-3.5 rounded-xl bg-amber-950/50 border border-amber-700/70 text-amber-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>You have unsaved project changes. Discard them and close?</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  data-testid="project-settings-keep-editing-btn"
                  onClick={() => setShowDiscardConfirm(false)}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold"
                >
                  Keep Editing
                </button>
                <button
                  type="button"
                  data-testid="project-settings-confirm-discard-btn"
                  onClick={handleConfirmDiscard}
                  className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-semibold"
                >
                  Discard Changes
                </button>
              </div>
            </div>
          )}

          {projectSwitchConflict && targetProject && (
            <div
              data-testid="project-switch-conflict-banner"
              className="p-3.5 rounded-xl bg-amber-950/50 border border-amber-700/70 text-amber-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>
                  Active project changed to <strong>{targetProject.name}</strong> while you had unsaved edits for <strong>{editingProjectName}</strong>. Saving is blocked to prevent cross-project overwrites.
                </span>
              </div>
              <button
                type="button"
                data-testid="project-switch-reload-btn"
                onClick={() => loadFromProject(targetProject)}
                className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold shrink-0"
              >
                Load {targetProject.name}
              </button>
            </div>
          )}

          {hasActiveRuns && (
            <div
              data-testid="project-active-runs-blocker"
              className="p-3 rounded-xl bg-amber-950/40 border border-amber-800/60 text-amber-200 flex items-start gap-2.5"
            >
              <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                <strong>Execution Blocker:</strong> {activeRunsCount} active task run(s) are currently executing on this project. Repository and agent preference edits are locked until active runs finish.
              </span>
            </div>
          )}

          {errorBanner && (
            <div
              data-testid="project-settings-error-banner"
              className="p-3 rounded-xl bg-rose-950/40 border border-rose-800/60 text-rose-200 flex items-start gap-2.5"
            >
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{errorBanner}</span>
            </div>
          )}

          {successBanner && (
            <div
              data-testid="project-settings-success-banner"
              className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-emerald-200 flex items-start gap-2.5"
            >
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>{successBanner}</span>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="space-y-4">
              <div>
                <label className="block text-slate-300 font-semibold mb-1" htmlFor="project-id-readonly">
                  Project ID (Read-only)
                </label>
                <input
                  id="project-id-readonly"
                  data-testid="project-id-input"
                  type="text"
                  readOnly
                  value={targetProject?.id || 'default'}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-indigo-300 text-xs font-mono cursor-default focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="project-name-input"
                  className="block text-slate-300 font-semibold mb-1 flex items-center justify-between"
                >
                  <span>Project Name</span>
                  {isDefaultProject && (
                    <span className="text-[11px] text-slate-500 flex items-center gap-1">
                      <Lock className="w-3 h-3" /> Fixed Identity
                    </span>
                  )}
                </label>
                <input
                  id="project-name-input"
                  data-testid="project-name-input"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isDefaultProject || isSaving}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                />
                {isDefaultProject && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    The default project's fixed identity cannot be modified.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1" htmlFor="project-description-input">
                  Description / Mission
                </label>
                <textarea
                  id="project-description-input"
                  data-testid="project-description-input"
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={isSaving}
                  placeholder="Summary of this project's scope, mission, and deliverables..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                />
              </div>

              <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-xl space-y-1.5 text-[11px] text-slate-400">
                <div className="flex justify-between">
                  <span className="text-slate-500">Status:</span>
                  <span className={`capitalize font-semibold ${isArchived ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {targetProject?.status || 'active'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Active Runs:</span>
                  <span className="font-mono text-slate-300">{activeRunsCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Created At:</span>
                  <span>{targetProject ? new Date(targetProject.createdAt).toLocaleString() : '—'}</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'repository' && (
            <div className="space-y-4">
              <div>
                <label className="block text-slate-300 font-semibold mb-1" htmlFor="project-local-path-input">
                  Local Repository Path
                </label>
                <div className="relative">
                  <input
                    id="project-local-path-input"
                    data-testid="project-local-path-input"
                    type="text"
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    disabled={hasActiveRuns || isSaving}
                    placeholder="/Users/.../my-repo"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  />
                  <Folder className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Absolute filesystem path to this project's target repository directory or worktree.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1" htmlFor="project-target-branch-input">
                    Target / Default Branch
                  </label>
                  <div className="relative">
                    <input
                      id="project-target-branch-input"
                      data-testid="project-target-branch-input"
                      type="text"
                      value={defaultBranch}
                      onChange={(e) => setDefaultBranch(e.target.value)}
                      disabled={hasActiveRuns || isSaving}
                      placeholder="main"
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                    />
                    <GitBranch className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
                  </div>
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1" htmlFor="project-write-mode-select">
                    Supported Write Mode
                  </label>
                  <select
                    id="project-write-mode-select"
                    data-testid="project-write-mode-select"
                    value={localWriteMode}
                    onChange={(e) => setLocalWriteMode(e.target.value as any)}
                    disabled={hasActiveRuns || isSaving}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  >
                    <option value="worktree">Isolated Git Worktree (Execution)</option>
                    <option value="direct_write">Direct Repository Write (Delivery)</option>
                    <option value="patch_export">Export Patches Only (Delivery)</option>
                    {localWriteMode === 'git_branch' && (
                      <option value="git_branch" disabled>
                        Branch Checkout (Disabled / Unsupported)
                      </option>
                    )}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1" htmlFor="project-repo-url-input">
                  Remote Repository URL (Optional)
                </label>
                <input
                  id="project-repo-url-input"
                  data-testid="project-repo-url-input"
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  disabled={hasActiveRuns || isSaving}
                  placeholder="https://github.com/org/repo.git"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                />
              </div>

              {!isDefaultProject && (
                <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-800/50 text-amber-200 text-[11px] flex items-start gap-2">
                  <Info className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <span>
                    Saving or verifying a repository does <strong>not</strong> enable automated daemon or cycle-step execution for secondary projects; execution remains manual workflow only.
                  </span>
                </div>
              )}

              {/* Verify Repository Button & Results */}
              <div className="pt-2 border-t border-slate-800/80">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-slate-400 text-xs">Verify local repository path and git branch:</span>
                  <button
                    type="button"
                    data-testid="verify-repo-btn"
                    onClick={handleVerifyRepo}
                    disabled={isVerifying || !localPath.trim() || projectSwitchConflict}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50 transition-colors shadow-sm"
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
                    <span>{isVerifying ? 'Verifying...' : 'Verify Repository'}</span>
                  </button>
                </div>

                {verificationResult && (
                  <div
                    data-testid="repo-verification-result"
                    className={`mt-3 p-3.5 rounded-xl border text-xs space-y-2 ${
                      verificationResult.valid
                        ? 'bg-emerald-950/30 border-emerald-800/50 text-emerald-200'
                        : 'bg-rose-950/30 border-rose-800/50 text-rose-200'
                    }`}
                  >
                    <div className="flex items-center justify-between font-semibold">
                      <div className="flex items-center gap-1.5">
                        {verificationResult.valid ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-rose-400" />
                        )}
                        <span>{verificationResult.valid ? 'Repository Validated Successfully' : 'Verification Issue Detected'}</span>
                      </div>
                      {verificationResult.headCommit && (
                        <span className="text-[10px] font-mono opacity-80">
                          HEAD: {verificationResult.headCommit.slice(0, 8)}
                        </span>
                      )}
                    </div>

                    {verificationResult.error && (
                      <p className="text-[11px] text-rose-300 font-medium">{verificationResult.error}</p>
                    )}

                    <ul className="space-y-1 text-[11px] text-slate-300/90 pl-1">
                      {verificationResult.details.map((d, i) => (
                        <li key={i} className="flex items-center gap-1.5">
                          <span className="text-slate-500">•</span>
                          <span>{d}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'preferences' && (
            <div className="space-y-4">
              {/* Stored Project Provider/Model Preferences */}
              <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3" data-testid="project-preferences-section">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-indigo-400" />
                    <span className="font-semibold text-white">Stored Project Agent Preferences</span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                    Stored Preference Only
                  </span>
                </div>

                <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 text-slate-300 text-[11px] flex items-start gap-2">
                  <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                  <span>
                    These preferences are saved per project, but active runtime execution currently reads per-task worker settings and server environment/application Gemini configuration rather than overriding from this panel.
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 font-semibold mb-1" htmlFor="project-default-provider">
                      Preferred Provider
                    </label>
                    <select
                      id="project-default-provider"
                      data-testid="project-default-provider-select"
                      value={defaultProvider}
                      onChange={(e) => setDefaultProvider(e.target.value)}
                      disabled={hasActiveRuns || isSaving}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                    >
                      <option value="">Unset (Use Runtime Default)</option>
                      <option value="gemini">Gemini</option>
                      <option value="openai">OpenAI</option>
                      <option value="custom">Custom Provider</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-300 font-semibold mb-1" htmlFor="project-default-model">
                      Preferred Model
                    </label>
                    <input
                      id="project-default-model"
                      data-testid="project-default-model-input"
                      type="text"
                      value={defaultModel}
                      onChange={(e) => setDefaultModel(e.target.value)}
                      disabled={hasActiveRuns || isSaving}
                      placeholder="e.g. gemini-3.8-flash"
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs text-slate-300 pt-1 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="project-require-approval-checkbox"
                    checked={requireApprovalByDefault}
                    onChange={(e) => setRequireApprovalByDefault(e.target.checked)}
                    disabled={hasActiveRuns || isSaving}
                    className="rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                  />
                  <span>Require approval before delivery by default (stored preference)</span>
                </label>
              </div>

              {/* Project-Specific Jira Integration Mapping */}
              <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3" data-testid="project-integrations-section">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Link2 className="w-4 h-4 text-cyan-400" />
                    <span className="font-semibold text-white">Project Jira Integration Mapping</span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700 capitalize">
                    {targetProject?.jira?.provisioningState || targetProject?.jira?.provisionStatus || 'unconfigured'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 font-semibold mb-1" htmlFor="project-jira-key-input">
                      Jira Project Key
                    </label>
                    <input
                      id="project-jira-key-input"
                      data-testid="project-jira-key-input"
                      type="text"
                      value={jiraProjectKey}
                      onChange={(e) => setJiraProjectKey(e.target.value.toUpperCase())}
                      disabled={isSaving}
                      placeholder="e.g. DUP"
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-300 font-semibold mb-1" htmlFor="project-jira-epic-input">
                      Jira Epic Key (Optional)
                    </label>
                    <input
                      id="project-jira-epic-input"
                      data-testid="project-jira-epic-input"
                      type="text"
                      value={jiraEpicKey}
                      onChange={(e) => setJiraEpicKey(e.target.value.toUpperCase())}
                      disabled={isSaving}
                      placeholder="e.g. DUP-100"
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                    />
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 space-y-1 pt-1 border-t border-slate-800/80">
                  <div className="flex justify-between gap-2">
                    <span>Jira Host / Connection Ref:</span>
                    <span className="font-mono text-slate-300">
                      {targetProject?.jira?.hostUrl || targetProject?.jira?.connectionRef || 'Not linked'}
                    </span>
                  </div>
                  {targetProject?.jira?.lastSync && (
                    <div className="flex justify-between gap-2">
                      <span>Last Sync:</span>
                      <span className="font-mono text-slate-300">{new Date(targetProject.jira.lastSync).toLocaleString()}</span>
                    </div>
                  )}
                  {targetProject?.jira?.error && (
                    <p className="text-rose-300">Last Jira Error: {targetProject.jira.error}</p>
                  )}
                </div>
              </div>

              {/* Execution Automation Capabilities & Blockers */}
              <div className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2" data-testid="project-blockers-section">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-cyan-400" />
                    <span className="font-semibold text-white">Execution Capabilities &amp; Blockers</span>
                  </div>
                  {isDefaultProject ? (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      Full Daemon
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      Manual Workflow
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-400">
                  {isDefaultProject
                    ? 'Automated engine daemon, cycle step execution, and worker dispatching are active on this primary workspace.'
                    : 'Autonomous background daemon and cycle stepping are disabled for secondary projects. Tasks and requirements must be managed manually.'}
                </p>
                {hasActiveRuns && (
                  <p className="text-[11px] text-amber-300">
                    Blocker: {activeRunsCount} active run(s) lock repository and preference updates until completion.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-3.5 border-t border-slate-800 bg-slate-950/80">
          <div className="text-[11px] text-slate-500">
            {projectSwitchConflict ? (
              <span className="text-amber-400 font-medium">Project switch conflict</span>
            ) : isDirty ? (
              <span className="text-amber-400 font-medium">Unsaved project changes</span>
            ) : (
              <span>Project settings synchronized</span>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              data-testid="cancel-project-settings-btn"
              onClick={handleRequestClose}
              disabled={isSaving}
              className="px-3.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="save-project-settings-btn"
              onClick={handleSave}
              disabled={isSaving || !isDirty || projectSwitchConflict}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50 transition-colors shadow-md shadow-indigo-600/20"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Saving...' : 'Save Project Settings'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
