import React from 'react';
import { useProject } from '../context/ProjectContext';
import { Plus, Sparkles, Share2, Layers } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';

interface EmptyProjectViewProps {
  onOpenAddTaskModal: () => void;
  onOpenIngestModal?: () => void;
  onOpenIntegrations?: () => void;
}

export const EmptyProjectView: React.FC<EmptyProjectViewProps> = ({
  onOpenAddTaskModal,
  onOpenIngestModal,
  onOpenIntegrations,
}) => {
  const { currentProject, isArchived } = useProject();

  return (
    <div className="flex flex-col items-center justify-center p-8 sm:p-12 text-center rounded-2xl bg-slate-900/60 border border-slate-800/80 shadow-inner max-w-xl mx-auto my-8">
      {/* Visual Avatar Lineup */}
      <div className="flex items-center -space-x-3 mb-6">
        <AgentAvatar role="coordinator" size={54} className="ring-4 ring-slate-900 z-30" />
        <AgentAvatar role="planner" size={48} className="ring-4 ring-slate-900 z-20" />
        <AgentAvatar role="coding-worker" size={48} className="ring-4 ring-slate-900 z-10" />
        <AgentAvatar role="verifier" size={44} className="ring-4 ring-slate-900" />
      </div>

      <h3 className="text-base sm:text-lg font-bold text-slate-100 mb-2">
        {isArchived ? 'Archived Project Workspace' : 'Empty Workspace Ready for Sprint Planning'}
      </h3>

      <p className="text-xs text-slate-400 max-w-md leading-relaxed mb-6">
        {isArchived
          ? `Project "${currentProject?.name}" is archived. All task records are preserved for audit history and read-only inspection.`
          : `Project "${currentProject?.name}" currently has 0 tasks on the board. The detective team is standing by to structure specifications, write implementations, and verify code.`}
      </p>

      {!isArchived && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onOpenAddTaskModal}
            className="flex items-center space-x-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg shadow-md transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" />
            <span>Add First Task</span>
          </button>

          {onOpenIngestModal && (
            <button
              type="button"
              onClick={onOpenIngestModal}
              className="flex items-center space-x-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg border border-slate-700 transition-all"
            >
              <Sparkles className="w-4 h-4 text-purple-400" />
              <span>Ingest Architecture Plan</span>
            </button>
          )}

          {onOpenIntegrations && (
            <button
              type="button"
              onClick={onOpenIntegrations}
              className="flex items-center space-x-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg border border-slate-700 transition-all"
            >
              <Share2 className="w-4 h-4 text-cyan-400" />
              <span>Sync from Jira</span>
            </button>
          )}
        </div>
      )}

      {currentProject?.repository?.repoUrl && (
        <div className="mt-8 pt-4 border-t border-slate-800/80 w-full flex items-center justify-between text-[11px] text-slate-400 font-mono">
          <span>Bound Target Repository:</span>
          <span className="text-indigo-400">{currentProject.repository.repoUrl}</span>
        </div>
      )}
    </div>
  );
};
