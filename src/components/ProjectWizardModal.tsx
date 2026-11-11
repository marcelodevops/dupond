import React, { useState, useEffect } from 'react';
import { useProject } from '../context/ProjectContext';
import {
  CreateProjectRequest,
  ProjectRepositoryConfig,
  JiraTemplateOption,
  JiraIssueTypeOption,
  ProvisionJiraRequest,
} from '../types/projectContract';
import { projectApi } from '../lib/projectApi';
import { AgentAvatar } from './AgentAvatar';
import {
  X,
  ChevronRight,
  ChevronLeft,
  FolderPlus,
  GitBranch,
  Share2,
  CheckCircle2,
  AlertTriangle,
  RotateCw,
  ExternalLink,
  ShieldCheck,
  Server,
  Layers,
} from 'lucide-react';

interface ProjectWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type WizardStep = 1 | 2 | 3 | 4;

export const ProjectWizardModal: React.FC<ProjectWizardModalProps> = ({ isOpen, onClose }) => {
  const { createProject, provisionJira } = useProject();

  const [step, setStep] = useState<WizardStep>(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Jira provisioning partial-failure state
  const [partialFailure, setPartialFailure] = useState<{
    createdProjectId: string;
    createdProjectName: string;
    jiraError: string;
    pendingJiraPayload: ProvisionJiraRequest;
  } | null>(null);

  // Step 1: General Info
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Step 2: Repository Configuration
  const [repoUrl, setRepoUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [targetDirectory, setTargetDirectory] = useState('.');
  const [localWriteMode, setLocalWriteMode] = useState<'worktree' | 'direct_write'>('worktree');

  // Step 3: Jira Setup
  const [jiraMode, setJiraMode] = useState<'none' | 'link_existing' | 'create_project' | 'create_epic'>('none');
  const [jiraProjectKey, setJiraProjectKey] = useState('');
  const [jiraProjectName, setJiraProjectName] = useState('');
  const [jiraEpicKey, setJiraEpicKey] = useState('');
  const [jiraEpicSummary, setJiraEpicSummary] = useState('');
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('');
  const [selectedIssueType, setSelectedIssueType] = useState('');
  const [jiraTemplates, setJiraTemplates] = useState<JiraTemplateOption[]>([]);
  const [jiraIssueTypes, setJiraIssueTypes] = useState<JiraIssueTypeOption[]>([]);
  const [confirmRemoteCreation, setConfirmRemoteCreation] = useState(false);
  const [jiraMetadataError, setJiraMetadataError] = useState<string | null>(null);

  // Fetch Jira metadata on open
  useEffect(() => {
    if (isOpen) {
      setJiraMetadataError(null);
      projectApi.fetchJiraMetadata()
        .then((meta) => {
          setJiraTemplates(meta.templates || []);
          setJiraIssueTypes(meta.issueTypes || []);
          if (meta.defaultTemplateKey) setSelectedTemplateKey(meta.defaultTemplateKey);
          const epicType = meta.issueTypes?.find((t) => t.isEpic);
          if (epicType) setSelectedIssueType(epicType.name);
        })
        .catch((err: any) => {
          setJiraMetadataError(err.message || 'Remote Jira metadata unavailable.');
        });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Validation per step
  const isStep1Valid = name.trim().length >= 2;
  const isStep2Valid = Boolean(repoUrl.trim());
  const isStep3Valid = (() => {
    if (jiraMode === 'none') return true;
    if (jiraMode === 'link_existing') return jiraProjectKey.trim().length >= 2;
    if (jiraMode === 'create_project') {
      return (
        jiraProjectKey.trim().length >= 2 &&
        jiraProjectName.trim().length >= 2 &&
        confirmRemoteCreation
      );
    }
    if (jiraMode === 'create_epic') {
      return (
        jiraProjectKey.trim().length >= 2 &&
        jiraEpicSummary.trim().length >= 3 &&
        confirmRemoteCreation
      );
    }
    return false;
  })();

  const resetForm = () => {
    setStep(1);
    setName('');
    setDescription('');
    setRepoUrl('');
    setLocalPath('');
    setDefaultBranch('main');
    setTargetDirectory('.');
    setLocalWriteMode('worktree');
    setJiraMode('none');
    setJiraProjectKey('');
    setJiraProjectName('');
    setJiraEpicKey('');
    setJiraEpicSummary('');
    setConfirmRemoteCreation(false);
    setErrorBanner(null);
    setPartialFailure(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setErrorBanner(null);
    setIsSubmitting(true);

    const repository: ProjectRepositoryConfig = {
      repoUrl: repoUrl.trim(),
      localPath: localPath.trim() || undefined,
      defaultBranch: defaultBranch.trim() || 'main',
      targetDirectory: targetDirectory.trim() || '.',
      localWriteMode,
    };

    // Unambiguous responsibilities: project creation establishes the local workspace shell.
    // Remote Jira project/epic creation is explicitly owned by the subsequent provisionJira call,
    // preventing remote resources from ever being provisioned twice.
    const projectPayload: CreateProjectRequest = {
      name: name.trim(),
      description: description.trim(),
      repository,
      jira: jiraMode === 'link_existing'
        ? {
            mode: 'link_existing',
            projectKey: jiraProjectKey.trim().toUpperCase(),
            epicKey: jiraEpicKey.trim().toUpperCase() || undefined,
          }
        : { mode: 'none' },
    };

    try {
      // 1. Create the local Dupond project first
      const createdProject = await createProject(projectPayload);

      // 2. If Jira provisioning was requested (create_project or create_epic or link_existing)
      if (jiraMode !== 'none') {
        let jiraReq: ProvisionJiraRequest;
        if (jiraMode === 'link_existing') {
          jiraReq = {
            mode: 'link_existing',
            projectKey: jiraProjectKey.trim().toUpperCase(),
            epicKey: jiraEpicKey.trim().toUpperCase() || undefined,
          };
        } else if (jiraMode === 'create_project') {
          jiraReq = {
            mode: 'create_project',
            projectKey: jiraProjectKey.trim().toUpperCase(),
            projectName: jiraProjectName.trim(),
            templateKey: selectedTemplateKey || undefined,
          };
        } else {
          jiraReq = {
            mode: 'create_epic',
            projectKey: jiraProjectKey.trim().toUpperCase(),
            epicSummary: jiraEpicSummary.trim(),
            issueType: selectedIssueType || 'Epic',
          };
        }

        try {
          await provisionJira(createdProject.id, jiraReq);
        } catch (jiraErr: any) {
          // Local project succeeded, but remote Jira provisioning failed!
          // Retain project, offer safe retry without pretending complete failure or false success.
          setPartialFailure({
            createdProjectId: createdProject.id,
            createdProjectName: createdProject.name,
            jiraError: jiraErr.message || 'Remote Jira creation failed.',
            pendingJiraPayload: jiraReq,
          });
          setIsSubmitting(false);
          return;
        }
      }

      // Success
      setIsSubmitting(false);
      handleClose();
    } catch (err: any) {
      setIsSubmitting(false);
      setErrorBanner(err.message || 'Failed to create project.');
    }
  };

  const handleRetryJiraProvision = async () => {
    if (!partialFailure || isSubmitting) return;
    setIsSubmitting(true);
    setErrorBanner(null);
    try {
      await provisionJira(partialFailure.createdProjectId, partialFailure.pendingJiraPayload);
      setIsSubmitting(false);
      handleClose();
    } catch (err: any) {
      setIsSubmitting(false);
      setPartialFailure({
        ...partialFailure,
        jiraError: err.message || 'Retry failed.',
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-wizard-title"
    >
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/50">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
              <FolderPlus className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 id="project-wizard-title" className="text-base font-bold text-slate-100">
                Create New Project
              </h2>
              <p className="text-xs text-slate-400">
                Setup workspace repository boundaries, specialist preferences, and Jira linkages
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Partial Failure Notice */}
        {partialFailure ? (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-800/60 text-amber-200 space-y-2">
              <div className="flex items-center space-x-2 font-bold text-sm">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
                <span>Dupond Project Created, But Remote Jira Provisioning Failed</span>
              </div>
              <p className="text-xs leading-relaxed">
                Project <strong>"{partialFailure.createdProjectName}"</strong> has been successfully registered and opened locally. However, the remote Jira call encountered an error:
              </p>
              <div className="p-2.5 rounded bg-slate-950/80 font-mono text-[11px] text-amber-300 border border-amber-900/50">
                {partialFailure.jiraError}
              </div>
              <p className="text-xs text-slate-300">
                Your local project is preserved and ready for use. You can retry Jira provisioning now, or continue into the workspace and manage Jira from Project Integrations later.
              </p>
            </div>

            <div className="flex items-center justify-end space-x-3 pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-300 hover:bg-slate-800 border border-slate-700"
              >
                Proceed to Workspace Without Jira
              </button>
              <button
                type="button"
                onClick={handleRetryJiraProvision}
                disabled={isSubmitting}
                className="flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50"
              >
                {isSubmitting ? <RotateCw className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
                <span>Retry Jira Provisioning</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Step Indicators */}
            <div className="px-6 py-3 bg-slate-950/30 border-b border-slate-800/60 flex items-center justify-between text-xs">
              <div className="flex items-center space-x-4">
                {[
                  { num: 1, label: 'General' },
                  { num: 2, label: 'Repository' },
                  { num: 3, label: 'Jira Integration' },
                  { num: 4, label: 'Review' },
                ].map((s) => (
                  <div
                    key={s.num}
                    className={`flex items-center space-x-1.5 ${
                      step === s.num
                        ? 'text-indigo-400 font-bold'
                        : step > s.num
                        ? 'text-emerald-400 font-medium'
                        : 'text-slate-500'
                    }`}
                  >
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        step === s.num
                          ? 'bg-indigo-600 text-white'
                          : step > s.num
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/40'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {step > s.num ? '✓' : s.num}
                    </span>
                    <span>{s.label}</span>
                  </div>
                ))}
              </div>
              <span className="text-slate-500 font-mono text-[11px]">Step {step} of 4</span>
            </div>

            {/* Error Banner */}
            {errorBanner && (
              <div className="mx-6 mt-4 p-3 rounded-lg bg-rose-950/50 border border-rose-800/60 text-rose-300 text-xs flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>{errorBanner}</span>
              </div>
            )}

            {/* Step Body */}
            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* STEP 1: General Info */}
              {step === 1 && (
                <div className="space-y-4 animate-in fade-in duration-150">
                  <div className="flex items-start space-x-3 p-3.5 rounded-xl bg-slate-950/50 border border-slate-800">
                    <AgentAvatar role="coordinator" size={44} className="shrink-0" />
                    <div className="text-xs text-slate-300 leading-relaxed">
                      <span className="font-bold text-slate-100 block mb-0.5">Dupond Coordinator</span>
                      Every project maintains its own isolated sprint boards, execution worktrees, and task lifecycles. Enter a clear project title to begin.
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-200 block mb-1">
                      Project Display Name <span className="text-rose-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Identity & Access Revamp"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      autoFocus
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-200 block mb-1">
                      Project Description
                    </label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={3}
                      placeholder="High-level engineering scope, milestones, and architectural goals..."
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              )}

              {/* STEP 2: Repository Configuration */}
              {step === 2 && (
                <div className="space-y-4 animate-in fade-in duration-150">
                  <div className="flex items-start space-x-3 p-3.5 rounded-xl bg-slate-950/50 border border-slate-800">
                    <AgentAvatar role="planner" size={44} className="shrink-0" />
                    <div className="text-xs text-slate-300 leading-relaxed">
                      <span className="font-bold text-slate-100 block mb-0.5">Planner Robot</span>
                      I configure the repository isolation boundary. Coding workers will mount isolated Git worktrees against this baseline branch.
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-200 block mb-1">
                      Repository URL / Slug <span className="text-rose-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      placeholder="e.g. org-name/service-repo or git@github.com:..."
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-slate-200 block mb-1">
                        Local Filesystem Path (Optional)
                      </label>
                      <input
                        type="text"
                        value={localPath}
                        onChange={(e) => setLocalPath(e.target.value)}
                        placeholder="e.g. /Users/mac/repos/service"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-200 block mb-1">
                        Default Baseline Branch
                      </label>
                      <input
                        type="text"
                        value={defaultBranch}
                        onChange={(e) => setDefaultBranch(e.target.value)}
                        placeholder="main"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-slate-200 block mb-1">
                        Target Subdirectory
                      </label>
                      <input
                        type="text"
                        value={targetDirectory}
                        onChange={(e) => setTargetDirectory(e.target.value)}
                        placeholder="."
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-200 block mb-1">
                        Workspace Write Mode
                      </label>
                      <select
                        value={localWriteMode}
                        onChange={(e) => setLocalWriteMode(e.target.value as any)}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        <option value="worktree">Isolated Git Worktree (Recommended)</option>
                        <option value="direct_write">Direct Repository Write</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 3: Jira Setup */}
              {step === 3 && (
                <div className="space-y-4 animate-in fade-in duration-150">
                  <div className="flex items-start space-x-3 p-3.5 rounded-xl bg-slate-950/50 border border-slate-800">
                    <AgentAvatar role="delivery" size={44} className="shrink-0" />
                    <div className="text-xs text-slate-300 leading-relaxed">
                      <span className="font-bold text-slate-100 block mb-0.5">Delivery Specialist</span>
                      Notice: <strong>Dupond Projects</strong> are local orchestrator workspaces. <strong>Jira Projects</strong> are remote Atlassian tracking containers. Choose how you wish to coordinate tickets:
                    </div>
                  </div>

                  {/* Mode Options */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {[
                      {
                        mode: 'none',
                        title: 'Skip Jira',
                        desc: 'Operate strictly with local Dupond sprint tasks and PR delivery.',
                      },
                      {
                        mode: 'link_existing',
                        title: 'Link Existing Jira Project',
                        desc: 'Connect to an established Jira project key and optional Epic.',
                      },
                      {
                        mode: 'create_project',
                        title: 'Create Remote Jira Project',
                        desc: 'Provision a brand new Jira software project using backend templates.',
                      },
                      {
                        mode: 'create_epic',
                        title: 'Create Epic in Jira Project',
                        desc: 'Add a new Epic issue within an existing Jira project.',
                      },
                    ].map((opt) => (
                      <label
                        key={opt.mode}
                        className={`flex flex-col p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                          jiraMode === opt.mode
                            ? 'bg-indigo-950/50 border-indigo-500 text-indigo-100 shadow-sm'
                            : 'bg-slate-950/40 border-slate-800 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-bold">{opt.title}</span>
                          <input
                            type="radio"
                            name="jiraMode"
                            checked={jiraMode === opt.mode}
                            onChange={() => setJiraMode(opt.mode as any)}
                            className="text-indigo-600 focus:ring-indigo-500"
                          />
                        </div>
                        <span className="text-[11px] text-slate-400">{opt.desc}</span>
                      </label>
                    ))}
                  </div>

                  {/* Mode Inputs */}
                  {jiraMode === 'link_existing' && (
                    <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
                      <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                        Existing Jira Coordinates
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs font-semibold text-slate-300 block mb-1">
                            Jira Project Key <span className="text-rose-400">*</span>
                          </label>
                          <input
                            type="text"
                            value={jiraProjectKey}
                            onChange={(e) => setJiraProjectKey(e.target.value.toUpperCase())}
                            placeholder="e.g. AEG or PROJ"
                            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 uppercase font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-semibold text-slate-300 block mb-1">
                            Optional Epic Key
                          </label>
                          <input
                            type="text"
                            value={jiraEpicKey}
                            onChange={(e) => setJiraEpicKey(e.target.value.toUpperCase())}
                            placeholder="e.g. AEG-100"
                            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 uppercase font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {jiraMode === 'create_project' && (
                    <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
                      <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                        New Remote Jira Project Parameters
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs font-semibold text-slate-300 block mb-1">
                            New Jira Project Name <span className="text-rose-400">*</span>
                          </label>
                          <input
                            type="text"
                            value={jiraProjectName}
                            onChange={(e) => setJiraProjectName(e.target.value)}
                            placeholder="e.g. Core Billing Engine"
                            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-semibold text-slate-300 block mb-1">
                            New Project Key <span className="text-rose-400">*</span>
                          </label>
                          <input
                            type="text"
                            value={jiraProjectKey}
                            onChange={(e) => setJiraProjectKey(e.target.value.toUpperCase())}
                            placeholder="e.g. CBE"
                            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 uppercase font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                      </div>

                      {jiraTemplates.length > 0 ? (
                        <div>
                          <label className="text-xs font-semibold text-slate-300 block mb-1">
                            Jira Project Template
                          </label>
                          <select
                            value={selectedTemplateKey}
                            onChange={(e) => setSelectedTemplateKey(e.target.value)}
                            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          >
                            {jiraTemplates.map((tmpl) => (
                              <option key={tmpl.key} value={tmpl.key}>
                                {tmpl.name} ({tmpl.key})
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : jiraMetadataError ? (
                        <div className="text-[11px] text-amber-300/80 font-medium bg-amber-950/30 p-2 rounded border border-amber-900/40">
                          Template metadata unavailable ({jiraMetadataError}). Default project template will be used.
                        </div>
                      ) : null}

                      <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-800/50 text-amber-200 text-xs">
                        <label className="flex items-start space-x-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={confirmRemoteCreation}
                            onChange={(e) => setConfirmRemoteCreation(e.target.checked)}
                            className="mt-0.5 rounded text-amber-600 focus:ring-amber-500"
                          />
                          <span className="leading-snug">
                            <strong>Explicit Confirmation:</strong> I authorize Dupond to create a new remote Jira project <code>{jiraProjectKey || '[KEY]'}</code> on our Atlassian instance.
                          </span>
                        </label>
                      </div>
                    </div>
                  )}

                  {jiraMode === 'create_epic' && (
                    <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
                      <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                        New Epic in Existing Jira Project
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs font-semibold text-slate-300 block mb-1">
                            Target Jira Project Key <span className="text-rose-400">*</span>
                          </label>
                          <input
                            type="text"
                            value={jiraProjectKey}
                            onChange={(e) => setJiraProjectKey(e.target.value.toUpperCase())}
                            placeholder="e.g. AEG"
                            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 uppercase font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-semibold text-slate-300 block mb-1">
                            Epic Summary / Title <span className="text-rose-400">*</span>
                          </label>
                          <input
                            type="text"
                            value={jiraEpicSummary}
                            onChange={(e) => setJiraEpicSummary(e.target.value)}
                            placeholder="e.g. Core Migration Milestone"
                            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                      </div>

                      <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-800/50 text-amber-200 text-xs">
                        <label className="flex items-start space-x-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={confirmRemoteCreation}
                            onChange={(e) => setConfirmRemoteCreation(e.target.checked)}
                            className="mt-0.5 rounded text-amber-600 focus:ring-amber-500"
                          />
                          <span className="leading-snug">
                            <strong>Explicit Confirmation:</strong> I authorize Dupond to create an Epic issue in Jira project <code>{jiraProjectKey || '[KEY]'}</code>.
                          </span>
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* STEP 4: Review */}
              {step === 4 && (
                <div className="space-y-4 animate-in fade-in duration-150">
                  <div className="flex items-start space-x-3 p-3.5 rounded-xl bg-slate-950/50 border border-slate-800">
                    <AgentAvatar role="verifier" size={44} className="shrink-0" />
                    <div className="text-xs text-slate-300 leading-relaxed">
                      <span className="font-bold text-slate-100 block mb-0.5">Verifier Robot</span>
                      Please inspect the final configuration. Note the strict boundary between local workspace setup and any remote Jira creations.
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3 text-xs">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                      <span className="text-slate-400">Project Name</span>
                      <span className="font-bold text-slate-100">{name}</span>
                    </div>
                    {description && (
                      <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                        <span className="text-slate-400">Description</span>
                        <span className="text-slate-200 truncate max-w-xs">{description}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                      <span className="text-slate-400">Repository</span>
                      <span className="font-mono text-indigo-300">{repoUrl}</span>
                    </div>
                    <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                      <span className="text-slate-400">Baseline Branch / Write Mode</span>
                      <span className="text-slate-200 font-mono">
                        {defaultBranch} ({localWriteMode})
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Jira Integration Mode</span>
                      <span className="font-semibold text-slate-200 capitalize">
                        {jiraMode.replace('_', ' ')}
                      </span>
                    </div>
                  </div>

                  {jiraMode !== 'none' && (
                    <div className="p-3.5 rounded-xl bg-indigo-950/30 border border-indigo-800/40 text-indigo-200 text-xs space-y-1">
                      <span className="font-bold block">Remote Jira Action:</span>
                      {jiraMode === 'link_existing' && (
                        <span>Will link to existing Jira project <strong>{jiraProjectKey}</strong>. No new remote entities will be created.</span>
                      )}
                      {jiraMode === 'create_project' && (
                        <span>Will provision remote Jira project <strong>"{jiraProjectName}" [{jiraProjectKey}]</strong>.</span>
                      )}
                      {jiraMode === 'create_epic' && (
                        <span>Will provision a new Epic <strong>"{jiraEpicSummary}"</strong> in Jira project <strong>{jiraProjectKey}</strong>.</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </form>

            {/* Modal Footer Controls */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 bg-slate-950/50">
              {step > 1 ? (
                <button
                  type="button"
                  onClick={() => setStep((s) => (s - 1) as WizardStep)}
                  disabled={isSubmitting}
                  className="flex items-center space-x-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span>Back</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-3 py-2 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
              )}

              {step < 4 ? (
                <button
                  type="button"
                  onClick={() => setStep((s) => (s + 1) as WizardStep)}
                  disabled={
                    (step === 1 && !isStep1Valid) ||
                    (step === 2 && !isStep2Valid) ||
                    (step === 3 && !isStep3Valid)
                  }
                  className="flex items-center space-x-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
                >
                  <span>Next</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  className="flex items-center space-x-2 px-5 py-2 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 shadow-md active:scale-95 transition-all"
                >
                  {isSubmitting ? (
                    <>
                      <RotateCw className="w-4 h-4 animate-spin" />
                      <span>Creating Project...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Confirm & Launch Workspace</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
