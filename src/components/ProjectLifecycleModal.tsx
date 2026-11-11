import React, { useState } from 'react';
import { useProject } from '../context/ProjectContext';
import {
  Archive,
  RefreshCw,
  X,
  AlertTriangle,
  ShieldCheck,
  CheckCircle2,
  Trash2,
  Lock,
} from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';

export const ProjectLifecycleModal: React.FC = () => {
  const {
    isLifecycleModalOpen,
    setIsLifecycleModalOpen,
    lifecycleActionType,
    targetLifecycleProject,
    archiveProject,
    resetProject,
  } = useProject();

  const [confirmNameInput, setConfirmNameInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [blockersList, setBlockersList] = useState<string[]>([]);

  if (!isLifecycleModalOpen || !targetLifecycleProject) return null;

  const isReset = lifecycleActionType === 'reset';
  const expectedName = targetLifecycleProject.name.trim();
  const isNameConfirmed = confirmNameInput.trim() === expectedName;

  const handleClose = () => {
    setConfirmNameInput('');
    setErrorBanner(null);
    setBlockersList([]);
    setIsSubmitting(false);
    setIsLifecycleModalOpen(false);
  };

  const handleAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setErrorBanner(null);
    setBlockersList([]);
    setIsSubmitting(true);

    try {
      if (isReset) {
        if (!isNameConfirmed) {
          setErrorBanner(`Please type "${expectedName}" exactly to confirm.`);
          setIsSubmitting(false);
          return;
        }

        await resetProject(targetLifecycleProject.id, {
          confirmProjectName: confirmNameInput.trim(),
          scope: {
            wipeTasks: true,
            wipeCycles: true,
            wipeWorktrees: true,
            preserveRemoteGit: true,
            preserveRemoteJira: true,
          },
        });
      } else {
        // Archive
        await archiveProject(targetLifecycleProject.id);
      }

      setIsSubmitting(false);
      handleClose();
    } catch (err: any) {
      setIsSubmitting(false);
      setErrorBanner(err.message || `Failed to ${isReset ? 'reset' : 'archive'} project.`);
      if (err.blockers && Array.isArray(err.blockers)) {
        setBlockersList(err.blockers);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lifecycle-modal-title"
    >
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/50">
          <div className="flex items-center space-x-3">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                isReset
                  ? 'bg-rose-500/10 border border-rose-500/20 text-rose-400'
                  : 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
              }`}
            >
              {isReset ? <RefreshCw className="w-5 h-5" /> : <Archive className="w-5 h-5" />}
            </div>
            <div>
              <h2 id="lifecycle-modal-title" className="text-base font-bold text-slate-100">
                {isReset ? 'Reset Project Workspace' : 'Archive Project'}
              </h2>
              <p className="text-xs text-slate-400">
                Project: <span className="font-semibold text-slate-200">{targetLifecycleProject.name}</span>
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

        {/* Content */}
        <form onSubmit={handleAction} className="p-6 space-y-4">
          {errorBanner && (
            <div className="p-3.5 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-300 text-xs space-y-1.5">
              <div className="flex items-center space-x-2 font-bold text-rose-200">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>Operation Blocked by Server</span>
              </div>
              <p>{errorBanner}</p>
              {blockersList.length > 0 && (
                <ul className="list-disc list-inside space-y-0.5 text-[11px] text-rose-200 pl-1">
                  {blockersList.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {isReset ? (
            // RESET FLOW
            <div className="space-y-4">
              <div className="flex items-start space-x-3 p-3.5 rounded-xl bg-rose-950/20 border border-rose-900/40 text-xs text-rose-200 leading-relaxed">
                <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block text-rose-100 mb-1">Permanent Workspace Data Wipe</span>
                  Resetting clears all local sprint tasks, cycle counts, worktrees, and ephemeral coordinator state for this project.
                </div>
              </div>

              {/* Scope Breakdown */}
              <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2 text-xs">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Data Scope Details:
                </h4>
                <div className="space-y-1.5 text-slate-300">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center space-x-1.5">
                      <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                      <span>Local Sprint Tasks & Subtasks</span>
                    </span>
                    <span className="text-rose-400 font-bold">WIPED</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center space-x-1.5">
                      <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                      <span>Sandbox Worktrees & Cache</span>
                    </span>
                    <span className="text-rose-400 font-bold">WIPED</span>
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t border-slate-800/80">
                    <span className="flex items-center space-x-1.5 text-emerald-300 font-medium">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Remote GitHub Repository</span>
                    </span>
                    <span className="text-emerald-400 font-bold">PRESERVED (Untouched)</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center space-x-1.5 text-emerald-300 font-medium">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Remote Jira Project & Issues</span>
                    </span>
                    <span className="text-emerald-400 font-bold">PRESERVED (Untouched)</span>
                  </div>
                </div>
              </div>

              {/* Confirmation input */}
              <div>
                <label className="text-xs font-semibold text-slate-200 block mb-1">
                  Type <span className="font-mono text-indigo-300 select-all">"{expectedName}"</span> to confirm:
                </label>
                <input
                  type="text"
                  value={confirmNameInput}
                  onChange={(e) => setConfirmNameInput(e.target.value)}
                  placeholder={expectedName}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-rose-500"
                  autoFocus
                />
              </div>
            </div>
          ) : (
            // ARCHIVE FLOW
            <div className="space-y-4">
              <div className="flex items-start space-x-3 p-3.5 rounded-xl bg-amber-950/20 border border-amber-900/40 text-xs text-amber-200 leading-relaxed">
                <Lock className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block text-amber-100 mb-1">Read-Only Project Archive</span>
                  Archiving preserves all tasks, logs, verification evidence, and deliverables for audit history while preventing further execution, automated runs, or state edits.
                </div>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed">
                You can view this project anytime by selecting it from the "Archived Projects" section in the project switcher.
              </p>
            </div>
          )}

          {/* Footer Controls */}
          <div className="flex items-center justify-end space-x-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || (isReset && !isNameConfirmed)}
              className={`flex items-center space-x-2 px-5 py-2 rounded-lg text-xs font-bold text-white shadow-md disabled:opacity-40 disabled:cursor-not-allowed transition-all ${
                isReset
                  ? 'bg-rose-600 hover:bg-rose-500'
                  : 'bg-amber-600 hover:bg-amber-500'
              }`}
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Processing...</span>
                </>
              ) : isReset ? (
                <>
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Reset Project Workspace</span>
                </>
              ) : (
                <>
                  <Archive className="w-3.5 h-3.5" />
                  <span>Confirm Archive</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
