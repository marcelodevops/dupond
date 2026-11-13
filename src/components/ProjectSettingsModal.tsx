import React, { useState, useEffect } from 'react';
import { useProject } from '../context/ProjectContext';
import { projectApi } from '../lib/projectApi';
import {
  Project,
  ProjectRepositoryConfig,
  PlanningReadiness,
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
  Cpu,
  Info,
  Save,
  Lock,
} from 'lucide-react';

interface ProjectSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (project: Project) => void;
}

type SettingsTab = 'general' | 'repository' | 'readiness';

export const ProjectSettingsModal: React.FC<ProjectSettingsModalProps> = ({
  isOpen,
  onClose,
  onSaved,
}) => {
  const { currentProject, updateProject } = useProject();

  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [isSaving, setIsSaving] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // Form Fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [localWriteMode, setLocalWriteMode] = useState<'worktree' | 'direct_write' | 'git_branch' | 'patch_export'>('worktree');

  // Verification & Readiness
  const [verificationResult, setVerificationResult] = useState<RepositoryVerificationResult | null>(null);
  const [planningReadiness, setPlanningReadiness] = useState<PlanningReadiness | null>(null);
  const [isLoadingReadiness, setIsLoadingReadiness] = useState(false);

  // Initialize from currentProject
  useEffect(() => {
    if (currentProject) {
      setName(currentProject.name || '');
      setDescription(currentProject.description || '');
      const repo = currentProject.repository || {};
      setLocalPath(repo.localPath || repo.path || '');
      setRepoUrl(repo.repoUrl || '');
      setDefaultBranch(repo.defaultBranch || 'main');
      setLocalWriteMode(repo.localWriteMode || 'worktree');
      setVerificationResult(null);
      setErrorBanner(null);
      setSuccessBanner(null);
    }
  }, [currentProject, isOpen]);

  // Load planning readiness on open
  useEffect(() => {
    if (!isOpen) return;
    let mounted = true;
    setIsLoadingReadiness(true);
    projectApi
      .getPlanningReadiness()
      .then((res) => {
        if (mounted) setPlanningReadiness(res);
      })
      .catch((err) => {
        if (mounted) {
          setPlanningReadiness({
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            ready: false,
            error: err.message || 'Failed to read provider readiness',
          });
        }
      })
      .finally(() => {
        if (mounted) setIsLoadingReadiness(false);
      });
    return () => {
      mounted = false;
    };
  }, [isOpen]);

  if (!isOpen || !currentProject) return null;

  const isDefaultProject = currentProject.id === 'default';

  // Dirty detection
  const origRepo = currentProject.repository || {};
  const isDirty =
    name !== (currentProject.name || '') ||
    description !== (currentProject.description || '') ||
    localPath !== (origRepo.localPath || origRepo.path || '') ||
    repoUrl !== (origRepo.repoUrl || '') ||
    defaultBranch !== (origRepo.defaultBranch || 'main') ||
    localWriteMode !== (origRepo.localWriteMode || 'worktree');

  const handleVerifyRepo = async () => {
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
      const result = await projectApi.verifyRepository(currentProject.id, candidate);
      setVerificationResult(result);
    } catch (err: any) {
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
      setIsVerifying(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setErrorBanner(null);
    setSuccessBanner(null);
    try {
      const repoPayload: ProjectRepositoryConfig = {
        localPath: localPath.trim() || undefined,
        repoUrl: repoUrl.trim() || undefined,
        defaultBranch: defaultBranch.trim() || 'main',
        localWriteMode,
      };

      const updated = await updateProject(currentProject.id, {
        ...(isDefaultProject ? {} : { name: name.trim() }),
        description: description.trim(),
        repository: repoPayload,
      });

      setSuccessBanner('Project settings successfully saved.');
      if (onSaved) onSaved(updated);
    } catch (err: any) {
      setErrorBanner(err.message || 'Failed to update project settings.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full shadow-2xl overflow-hidden my-auto flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                Project Settings: {currentProject.name}
                {isDefaultProject && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                    Default Project
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-400">Review and configure repository paths, git branches, and execution readiness.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs Bar */}
        <div className="flex border-b border-slate-800 bg-slate-950/40 px-6 gap-4">
          <button
            onClick={() => setActiveTab('general')}
            className={`py-3 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'general'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            General Identity
          </button>
          <button
            onClick={() => setActiveTab('repository')}
            className={`py-3 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'repository'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Repository & Git
          </button>
          <button
            onClick={() => setActiveTab('readiness')}
            className={`py-3 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'readiness'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Readiness & Providers
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-5 text-xs text-slate-300">
          {errorBanner && (
            <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-800/60 text-rose-200 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{errorBanner}</span>
            </div>
          )}

          {successBanner && (
            <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-emerald-200 flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>{successBanner}</span>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="space-y-4">
              <div>
                <label className="block text-slate-300 font-semibold mb-1 flex items-center justify-between">
                  <span>Project Name</span>
                  {isDefaultProject && (
                    <span className="text-[11px] text-slate-500 flex items-center gap-1">
                      <Lock className="w-3 h-3" /> Fixed Identity
                    </span>
                  )}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isDefaultProject}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                />
                {isDefaultProject && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    The default project's fixed identity cannot be modified.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Description</label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Summary of this project's scope, mission, and deliverables..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-xl space-y-1.5 text-[11px] text-slate-400">
                <div className="flex justify-between">
                  <span className="text-slate-500">Project Identifier:</span>
                  <code className="text-indigo-300 font-mono">{currentProject.id}</code>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Status:</span>
                  <span className="capitalize text-emerald-400 font-semibold">{currentProject.status}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Created At:</span>
                  <span>{new Date(currentProject.createdAt).toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'repository' && (
            <div className="space-y-4">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Local Repository Path</label>
                <div className="relative">
                  <input
                    type="text"
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    placeholder="/Users/.../my-repo"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
                  />
                  <Folder className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Absolute filesystem path to the target repository directory or worktree.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">Target / Default Branch</label>
                  <div className="relative">
                    <input
                      type="text"
                      value={defaultBranch}
                      onChange={(e) => setDefaultBranch(e.target.value)}
                      placeholder="main"
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
                    />
                    <GitBranch className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
                  </div>
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">Local Write Mode</label>
                  <select
                    value={localWriteMode}
                    onChange={(e: any) => setLocalWriteMode(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
                  >
                    <option value="worktree">Isolated Git Worktree (Recommended)</option>
                    <option value="direct_write">Direct Repository Write</option>
                    <option value="git_branch">Branch Checkout</option>
                    <option value="patch_export">Export Patches Only</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Remote Repository URL (Optional)</label>
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Verify Repository Button & Results */}
              <div className="pt-2 border-t border-slate-800/80">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 text-xs">Verify local repository path and git branch:</span>
                  <button
                    type="button"
                    onClick={handleVerifyRepo}
                    disabled={isVerifying || !localPath.trim()}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50 transition-colors shadow-sm"
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
                    <span>{isVerifying ? 'Verifying...' : 'Verify Repository'}</span>
                  </button>
                </div>

                {verificationResult && (
                  <div
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

          {activeTab === 'readiness' && (
            <div className="space-y-4">
              <div className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-indigo-400" />
                    <span className="font-semibold text-white">AI Planning Readiness</span>
                  </div>
                  {isLoadingReadiness ? (
                    <RotateCw className="w-3.5 h-3.5 animate-spin text-slate-500" />
                  ) : planningReadiness?.ready ? (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      Ready
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
                      Unconfigured
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-400 space-y-1">
                  <div className="flex justify-between">
                    <span>Provider:</span>
                    <span className="font-mono text-slate-200">{planningReadiness?.provider || 'gemini'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Model:</span>
                    <span className="font-mono text-slate-200">{planningReadiness?.model || 'gemini-2.5-flash'}</span>
                  </div>
                  {planningReadiness?.error && (
                    <p className="text-rose-300 text-[10px] mt-1 pt-1 border-t border-rose-900/40">
                      {planningReadiness.error}
                    </p>
                  )}
                </div>
              </div>

              <div className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-cyan-400" />
                    <span className="font-semibold text-white">Execution Automation Capabilities</span>
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
                    ? 'Automated engine daemon, cycle step execution, and worker dispatching are fully active on this primary workspace.'
                    : 'Autonomous background daemon and cycle stepping are disabled for secondary projects. Tasks and requirements must be managed manually.'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-800 bg-slate-950/80">
          <div className="text-[11px] text-slate-500">
            {isDirty ? (
              <span className="text-amber-400 font-medium">Unsaved changes</span>
            ) : (
              <span>All settings synchronized</span>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="px-3.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || !isDirty}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50 transition-colors shadow-md shadow-indigo-600/20"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Saving...' : 'Save Settings'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
