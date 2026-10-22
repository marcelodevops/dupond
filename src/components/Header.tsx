import React from 'react';
import { 
  Bot, 
  Play, 
  Pause, 
  RotateCw, 
  Sparkles, 
  FileText, 
  Kanban, 
  GitGraph, 
  Users, 
  Sliders, 
  Share2, 
  Activity,
  Layers
} from 'lucide-react';

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isRunningAuto: boolean;
  onToggleAuto: () => void;
  onRunSingleStep: () => void;
  isProcessingStep: boolean;
  onOpenIngestModal: () => void;
  onOpenReportModal: () => void;
  projectTitle: string;
  cycleCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  isRunningAuto,
  onToggleAuto,
  onRunSingleStep,
  isProcessingStep,
  onOpenIngestModal,
  onOpenReportModal,
  projectTitle,
  cycleCount,
}) => {
  const tabs = [
    { id: 'kanban', label: 'Kanban Board', icon: Kanban },
    { id: 'diagrams', label: 'Diagrams & Progress', icon: GitGraph },
    { id: 'resources', label: 'Resource Allocation', icon: Users },
    { id: 'reports', label: 'Stakeholder Reports', icon: FileText },
    { id: 'orchestrator', label: 'Orchestrator Studio', icon: Sliders },
    { id: 'integrations', label: 'Jira & Slack Sync', icon: Share2 },
  ];

  return (
    <header className="sticky top-0 z-40 bg-slate-950/95 backdrop-blur-md border-b border-slate-800 text-slate-100 shadow-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand & Project Info */}
          <div className="flex items-center space-x-3">
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-600 to-cyan-500 p-[2px] shadow-lg shadow-indigo-500/20">
              <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
                <Bot className="w-5 h-5 text-indigo-400 animate-pulse" />
              </div>
              <span className="absolute -top-1 -right-1 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-white via-slate-100 to-indigo-200 bg-clip-text text-transparent">
                  Aegis Orchestrator
                </span>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  Autonomous v2.4
                </span>
              </div>
              <p className="text-xs text-slate-400 truncate max-w-xs sm:max-w-md">
                Project: <span className="text-slate-200 font-medium">{projectTitle}</span>
              </p>
            </div>
          </div>

          {/* Engine Controls & Quick Actions */}
          <div className="flex items-center space-x-2 sm:space-x-3">
            {/* Orchestration Cycle Tracker */}
            <div className="hidden lg:flex items-center space-x-1.5 px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-300">
              <Activity className="w-3.5 h-3.5 text-indigo-400" />
              <span>Cycles: <strong className="text-slate-100">{cycleCount}</strong></span>
            </div>

            {/* Step-by-Step execution button */}
            <button
              onClick={onRunSingleStep}
              disabled={isProcessingStep || isRunningAuto}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all duration-150 ${
                isProcessingStep
                  ? 'bg-indigo-900/50 border-indigo-700 text-indigo-200 cursor-wait'
                  : isRunningAuto
                  ? 'bg-slate-900 border-slate-800 text-slate-500 cursor-not-allowed'
                  : 'bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-200 hover:text-white hover:border-slate-600 active:scale-95'
              }`}
              title="Execute single agent orchestration step"
            >
              <RotateCw className={`w-3.5 h-3.5 ${isProcessingStep ? 'animate-spin text-indigo-400' : ''}`} />
              <span className="hidden sm:inline">Next Cycle</span>
            </button>

            {/* Auto-Pilot Toggle */}
            <button
              onClick={onToggleAuto}
              className={`flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 shadow-sm ${
                isRunningAuto
                  ? 'bg-rose-500/20 border border-rose-500/40 text-rose-300 hover:bg-rose-500/30 ring-2 ring-rose-500/20'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-700/20'
              }`}
            >
              {isRunningAuto ? (
                <>
                  <Pause className="w-3.5 h-3.5 fill-current" />
                  <span>Pause Engine</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Auto-Pilot</span>
                </>
              )}
            </button>

            {/* Quick Ingest Plan Modal */}
            <button
              onClick={onOpenIngestModal}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 text-white shadow-md shadow-indigo-600/20 transition-all"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Ingest Plan</span>
            </button>

            {/* Quick Report Brief */}
            <button
              onClick={onOpenReportModal}
              className="hidden md:flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-all"
            >
              <FileText className="w-3.5 h-3.5 text-cyan-400" />
              <span>Report</span>
            </button>
          </div>
        </div>

        {/* Navigation Tabs Bar */}
        <nav className="flex space-x-1 overflow-x-auto py-2 scrollbar-none border-t border-slate-800/60">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150 ${
                  isActive
                    ? 'bg-indigo-600/20 border border-indigo-500/40 text-indigo-300 shadow-sm shadow-indigo-500/10'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-indigo-400' : 'text-slate-500'}`} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
};
