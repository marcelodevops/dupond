import React, { useState, useRef, useEffect } from 'react';
import { useProject } from '../context/ProjectContext';
import { 
  FolderGit2, 
  ChevronDown, 
  Plus, 
  Check, 
  Archive, 
  RefreshCw, 
  Search, 
  AlertTriangle,
  Settings,
  Layers,
  ExternalLink
} from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';

export const ProjectSwitcher: React.FC = () => {
  const {
    currentProject,
    activeProjects,
    archivedProjects,
    isSwitchingProject,
    isArchived,
    switchProject,
    setIsCreateWizardOpen,
    openResetModal,
    openArchiveModal,
  } = useProject();

  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside or escape key
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const filteredActive = activeProjects.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.repository?.repoUrl?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredArchived = archivedProjects.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="relative inline-block text-left" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label="Switch Dupond Project"
        className={`flex items-center space-x-2.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
          isArchived
            ? 'bg-amber-950/40 border-amber-800/60 text-amber-200 hover:bg-amber-900/50'
            : 'bg-slate-900/90 border-slate-800 text-slate-100 hover:bg-slate-800/90 hover:border-slate-700'
        } focus:outline-none focus:ring-2 focus:ring-indigo-500`}
      >
        <div className="flex items-center space-x-2 min-w-0">
          <FolderGit2 className={`w-3.5 h-3.5 shrink-0 ${isArchived ? 'text-amber-400' : 'text-indigo-400'}`} />
          <div className="flex items-center space-x-1.5 truncate">
            <span className="font-semibold truncate max-w-[140px] sm:max-w-[200px]">
              {currentProject?.name || 'Select Project'}
            </span>
            {isArchived && (
              <span className="px-1.5 py-0.2 text-[9px] font-bold rounded uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30">
                Archived
              </span>
            )}
            {isSwitchingProject && (
              <RefreshCw className="w-3 h-3 text-indigo-400 animate-spin shrink-0" />
            )}
          </div>
        </div>
        <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div 
          className="absolute left-0 mt-2 w-80 sm:w-96 rounded-xl bg-slate-950 border border-slate-800 shadow-2xl z-50 overflow-hidden focus:outline-none animate-in fade-in zoom-in-95 duration-100"
          role="menu"
          aria-orientation="vertical"
        >
          {/* Header & Search */}
          <div className="p-3 border-b border-slate-800/80 bg-slate-900/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Dupond Projects
              </span>
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  setIsCreateWizardOpen(true);
                }}
                className="flex items-center space-x-1 text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 px-2 py-0.5 rounded hover:bg-indigo-950/50 transition-colors"
              >
                <Plus className="w-3 h-3" />
                <span>New Project</span>
              </button>
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search projects or repositories..."
                className="w-full pl-8 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                autoFocus
              />
            </div>
          </div>

          {/* Project Lists */}
          <div className="max-h-72 overflow-y-auto p-2 space-y-1 divide-y divide-slate-800/40">
            {/* Active Projects */}
            <div className="space-y-1 pb-1">
              <div className="text-[10px] font-semibold text-slate-400 px-2 py-1">
                Active Projects ({filteredActive.length})
              </div>
              {filteredActive.length === 0 ? (
                <div className="text-xs text-slate-500 px-3 py-2 italic">
                  No active projects match your search.
                </div>
              ) : (
                filteredActive.map((proj) => {
                  const isSelected = currentProject?.id === proj.id;
                  return (
                    <button
                      key={proj.id}
                      type="button"
                      onClick={() => {
                        setIsOpen(false);
                        switchProject(proj.id);
                      }}
                      className={`w-full text-left flex items-start justify-between p-2 rounded-lg text-xs transition-colors ${
                        isSelected
                          ? 'bg-indigo-600/15 border border-indigo-500/30 text-indigo-100'
                          : 'hover:bg-slate-900/80 text-slate-300 hover:text-slate-100'
                      }`}
                    >
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center space-x-1.5">
                          <span className="font-semibold truncate">{proj.name}</span>
                          {isSelected && <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />}
                        </div>
                        {proj.repository?.repoUrl && (
                          <div className="text-[11px] text-slate-400 font-mono truncate mt-0.5">
                            {proj.repository.repoUrl}
                          </div>
                        )}
                        {proj.jira?.projectKey && (
                          <div className="text-[10px] text-indigo-400 font-mono mt-0.5">
                            Jira: {proj.jira.projectKey} {proj.jira.epicKey ? `(${proj.jira.epicKey})` : ''}
                          </div>
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800 shrink-0">
                        {proj.taskCount ?? 0} tasks
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            {/* Archived Projects Section */}
            {(archivedProjects.length > 0 || searchQuery) && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setShowArchived(!showArchived)}
                  className="w-full flex items-center justify-between text-[10px] font-semibold text-slate-400 px-2 py-1 hover:text-slate-300"
                >
                  <span className="flex items-center space-x-1.5">
                    <Archive className="w-3 h-3 text-amber-500/80" />
                    <span>Archived Projects ({filteredArchived.length})</span>
                  </span>
                  <ChevronDown className={`w-3 h-3 transition-transform ${showArchived ? 'rotate-180' : ''}`} />
                </button>

                {showArchived && (
                  <div className="space-y-1 mt-1">
                    {filteredArchived.length === 0 ? (
                      <div className="text-xs text-slate-500 px-3 py-2 italic">
                        No archived projects match.
                      </div>
                    ) : (
                      filteredArchived.map((proj) => {
                        const isSelected = currentProject?.id === proj.id;
                        return (
                          <button
                            key={proj.id}
                            type="button"
                            onClick={() => {
                              setIsOpen(false);
                              switchProject(proj.id);
                            }}
                            className={`w-full text-left flex items-start justify-between p-2 rounded-lg text-xs opacity-75 hover:opacity-100 transition-all ${
                              isSelected
                                ? 'bg-amber-950/40 border border-amber-800/50 text-amber-200'
                                : 'hover:bg-slate-900/80 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            <div className="min-w-0 pr-2">
                              <div className="flex items-center space-x-1.5">
                                <span className="font-semibold truncate">{proj.name}</span>
                                <span className="text-[9px] uppercase px-1 py-0.2 rounded bg-amber-900/60 text-amber-300 font-bold">
                                  Archived
                                </span>
                              </div>
                              {proj.repository?.repoUrl && (
                                <div className="text-[11px] text-slate-500 font-mono truncate mt-0.5">
                                  {proj.repository.repoUrl}
                                </div>
                              )}
                            </div>
                            <span className="text-[10px] font-mono text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800 shrink-0">
                              {proj.taskCount ?? 0} tasks
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer Actions */}
          {currentProject && (
            <div className="p-2 border-t border-slate-800/80 bg-slate-900/40 flex items-center justify-between text-xs">
              <span className="text-[11px] text-slate-400 truncate max-w-[160px]">
                Active: <span className="text-slate-200 font-semibold">{currentProject.name}</span>
              </span>
              <div className="flex items-center space-x-1">
                {!isArchived && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false);
                      openArchiveModal(currentProject);
                    }}
                    title="Archive this project"
                    className="p-1.5 text-slate-400 hover:text-amber-300 rounded hover:bg-slate-800 transition-colors"
                  >
                    <Archive className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    openResetModal(currentProject);
                  }}
                  title="Reset workspace data"
                  className="p-1.5 text-slate-400 hover:text-rose-400 rounded hover:bg-slate-800 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
