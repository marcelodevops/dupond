import React, { useState } from 'react';
import { 
  Task, 
  TaskStatus, 
  Agent, 
  Epic, 
  Priority 
} from '../types';
import { 
  Plus, 
  Search, 
  Filter, 
  AlertCircle, 
  CheckCircle2, 
  Clock, 
  ArrowRight, 
  ArrowLeft, 
  Share2, 
  Bot, 
  Sparkles,
  Link2,
  Tag
} from 'lucide-react';

interface KanbanBoardProps {
  tasks: Task[];
  agents: Agent[];
  epics: Epic[];
  onTaskClick: (task: Task) => void;
  onUpdateTaskStatus: (taskId: string, newStatus: TaskStatus) => void;
  onOpenAddTaskModal: () => void;
  activeProcessingTaskId?: string;
}

const COLUMNS: { id: TaskStatus; label: string; color: string; badgeBg: string }[] = [
  { id: 'backlog', label: 'Backlog', color: 'border-slate-700', badgeBg: 'bg-slate-800 text-slate-300' },
  { id: 'todo', label: 'To Do', color: 'border-blue-800', badgeBg: 'bg-blue-900/50 text-blue-300 border border-blue-700/50' },
  { id: 'in_progress', label: 'In Progress', color: 'border-indigo-800', badgeBg: 'bg-indigo-900/50 text-indigo-300 border border-indigo-700/50' },
  { id: 'review', label: 'Review & QA', color: 'border-amber-800', badgeBg: 'bg-amber-900/50 text-amber-300 border border-amber-700/50' },
  { id: 'done', label: 'Done', color: 'border-emerald-800', badgeBg: 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50' },
];

export const KanbanBoard: React.FC<KanbanBoardProps> = ({
  tasks,
  agents,
  epics,
  onTaskClick,
  onUpdateTaskStatus,
  onOpenAddTaskModal,
  activeProcessingTaskId,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState<string>('all');
  const [selectedPriority, setSelectedPriority] = useState<string>('all');
  const [selectedEpicId, setSelectedEpicId] = useState<string>('all');

  // Filter tasks based on filters
  const filteredTasks = tasks.filter((t) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchText = `${t.key} ${t.title} ${t.description} ${t.tags.join(' ')}`.toLowerCase();
      if (!matchText.includes(q)) return false;
    }
    if (selectedAgentId !== 'all' && t.assignedAgentId !== selectedAgentId) return false;
    if (selectedPriority !== 'all' && t.priority !== selectedPriority) return false;
    if (selectedEpicId !== 'all' && t.epicId !== selectedEpicId) return false;
    return true;
  });

  // Helper: check if task dependencies are satisfied
  const checkDependenciesSatisfied = (task: Task): { satisfied: boolean; blockingKeys: string[] } => {
    if (!task.dependencies || task.dependencies.length === 0) return { satisfied: true, blockingKeys: [] };
    const blockingKeys: string[] = [];
    task.dependencies.forEach((depId) => {
      const depTask = tasks.find((t) => t.id === depId);
      if (depTask && depTask.status !== 'done') {
        blockingKeys.push(depTask.key);
      }
    });
    return {
      satisfied: blockingKeys.length === 0,
      blockingKeys,
    };
  };

  const getPriorityBadge = (priority: Priority) => {
    switch (priority) {
      case 'critical':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">CRITICAL</span>;
      case 'high':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-orange-500/20 text-orange-300 border border-orange-500/30">HIGH</span>;
      case 'medium':
        return <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30">MED</span>;
      case 'low':
        return <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-500/20 text-slate-400 border border-slate-500/30">LOW</span>;
    }
  };

  const getNextStatus = (current: TaskStatus): TaskStatus | null => {
    const order: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];
    const idx = order.indexOf(current);
    if (idx < order.length - 1) return order[idx + 1];
    return null;
  };

  const getPrevStatus = (current: TaskStatus): TaskStatus | null => {
    const order: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];
    const idx = order.indexOf(current);
    if (idx > 0) return order[idx - 1];
    return null;
  };

  return (
    <div className="space-y-4">
      {/* Control / Filter Bar */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3 sm:p-4 shadow-md backdrop-blur-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Search box */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search tasks by key, title, tags, or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Agent filter */}
            <div className="flex items-center space-x-1">
              <Filter className="w-3.5 h-3.5 text-slate-400" />
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="all">All Agents ({agents.length})</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.role.split(' ')[0]})</option>
                ))}
              </select>
            </div>

            {/* Priority filter */}
            <select
              value={selectedPriority}
              onChange={(e) => setSelectedPriority(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="all">All Priorities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>

            {/* Epic filter */}
            <select
              value={selectedEpicId}
              onChange={(e) => setSelectedEpicId(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 max-w-[150px] truncate"
            >
              <option value="all">All Epics ({epics.length})</option>
              {epics.map((ep) => (
                <option key={ep.id} value={ep.id}>{ep.title}</option>
              ))}
            </select>

            {/* Reset button if active */}
            {(searchQuery || selectedAgentId !== 'all' || selectedPriority !== 'all' || selectedEpicId !== 'all') && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setSelectedAgentId('all');
                  setSelectedPriority('all');
                  setSelectedEpicId('all');
                }}
                className="text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1 underline"
              >
                Reset Filters
              </button>
            )}

            {/* Add Task Button */}
            <button
              onClick={onOpenAddTaskModal}
              className="flex items-center space-x-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow transition-all ml-auto"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Task</span>
            </button>
          </div>
        </div>
      </div>

      {/* 5-Column Responsive Board */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3.5 items-start">
        {COLUMNS.map((col) => {
          const colTasks = filteredTasks.filter((t) => t.status === col.id);
          const totalColHours = colTasks.reduce((sum, t) => sum + (t.estimatedHours || 0), 0);

          return (
            <div
              key={col.id}
              className="flex flex-col bg-slate-900/60 border border-slate-800/80 rounded-xl p-3 min-h-[500px] shadow-sm backdrop-blur-sm"
            >
              {/* Column Header */}
              <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
                <div className="flex items-center space-x-2">
                  <span className="font-semibold text-xs tracking-wide text-slate-200 uppercase">
                    {col.label}
                  </span>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${col.badgeBg}`}>
                    {colTasks.length}
                  </span>
                </div>
                <span className="text-[11px] text-slate-500 font-medium">
                  {totalColHours}h
                </span>
              </div>

              {/* Tasks List */}
              <div className="flex-1 space-y-2.5 overflow-y-auto max-h-[calc(100vh-280px)] pr-0.5">
                {colTasks.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-36 border border-dashed border-slate-800 rounded-lg text-slate-600 text-xs">
                    <span>No tasks in {col.label}</span>
                  </div>
                ) : (
                  colTasks.map((task) => {
                    const assignee = agents.find((a) => a.id === task.assignedAgentId);
                    const epic = epics.find((e) => e.id === task.epicId);
                    const { satisfied, blockingKeys } = checkDependenciesSatisfied(task);
                    const completedSubtasks = task.subtasks.filter((s) => s.completed).length;
                    const isProcessing = activeProcessingTaskId === task.id;

                    return (
                      <div
                        key={task.id}
                        onClick={() => onTaskClick(task)}
                        className={`group relative bg-slate-950/90 hover:bg-slate-900 border rounded-xl p-3 cursor-pointer transition-all duration-200 shadow-sm hover:shadow-md hover:border-indigo-500/50 ${
                          isProcessing
                            ? 'border-indigo-500 ring-2 ring-indigo-500/30 bg-indigo-950/20'
                            : !satisfied
                            ? 'border-amber-900/40'
                            : 'border-slate-800/90'
                        }`}
                      >
                        {/* Live Agent Working Glow Indicator */}
                        {isProcessing && (
                          <div className="mb-2 flex items-center justify-between px-2 py-1 rounded bg-indigo-500/20 border border-indigo-500/40 text-[11px] text-indigo-300 font-semibold animate-pulse">
                            <span className="flex items-center space-x-1">
                              <Sparkles className="w-3 h-3 text-indigo-400" />
                              <span>Agent Executing Now...</span>
                            </span>
                            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-ping" />
                          </div>
                        )}

                        {/* Top Row: Key, Priority, Jira & Epic */}
                        <div className="flex items-center justify-between gap-1 mb-1.5">
                          <div className="flex items-center space-x-1.5">
                            <span className="font-mono text-[11px] font-bold text-indigo-400">
                              {task.key}
                            </span>
                            {task.jiraSynced && (
                              <span
                                title="Synced with Jira"
                                className="flex items-center text-[10px] text-sky-400 bg-sky-950/60 px-1.5 py-0.2 rounded border border-sky-800/40"
                              >
                                <Link2 className="w-2.5 h-2.5 mr-0.5" />
                                Jira
                              </span>
                            )}
                          </div>
                          {getPriorityBadge(task.priority)}
                        </div>

                        {/* Title */}
                        <h4 className="text-xs font-semibold text-slate-100 group-hover:text-indigo-200 transition-colors line-clamp-2 mb-1.5">
                          {task.title}
                        </h4>

                        {/* Description Preview */}
                        <p className="text-[11px] text-slate-400 line-clamp-2 mb-2 leading-relaxed">
                          {task.description}
                        </p>

                        {/* Epic Label */}
                        {epic && (
                          <div className="flex items-center space-x-1 mb-2">
                            <span
                              className="w-1.5 h-1.5 rounded-full"
                              style={{ backgroundColor: epic.color }}
                            />
                            <span className="text-[10px] font-medium text-slate-400 truncate max-w-[150px]">
                              {epic.title}
                            </span>
                          </div>
                        )}

                        {/* Dependency Blocker Warning */}
                        {!satisfied && (
                          <div className="mb-2 flex items-center space-x-1 text-[10px] text-amber-300 bg-amber-950/40 border border-amber-800/50 px-2 py-0.5 rounded">
                            <AlertCircle className="w-3 h-3 text-amber-400 shrink-0" />
                            <span className="truncate">Blocked by: {blockingKeys.join(', ')}</span>
                          </div>
                        )}

                        {/* Subtasks progress bar */}
                        {task.subtasks.length > 0 && (
                          <div className="mb-2.5">
                            <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                              <span className="flex items-center space-x-1">
                                <CheckCircle2 className="w-3 h-3 text-slate-500" />
                                <span>Subtasks</span>
                              </span>
                              <span>
                                {completedSubtasks}/{task.subtasks.length}
                              </span>
                            </div>
                            <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
                              <div
                                className="bg-indigo-500 h-1 rounded-full transition-all duration-300"
                                style={{
                                  width: `${(completedSubtasks / task.subtasks.length) * 100}%`,
                                }}
                              />
                            </div>
                          </div>
                        )}

                        {/* Tags */}
                        {task.tags && task.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-2.5">
                            {task.tags.slice(0, 3).map((tag, idx) => (
                              <span
                                key={idx}
                                className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] text-slate-400"
                              >
                                #{tag}
                              </span>
                            ))}
                            {task.tags.length > 3 && (
                              <span className="text-[9px] text-slate-500 self-center">
                                +{task.tags.length - 3}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Card Bottom Row: Assignee & Hours & Transitions */}
                        <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 text-[11px]">
                          {/* Assignee Avatar & Assumed Role */}
                          <div className="flex items-center space-x-1.5 min-w-0">
                            {assignee ? (
                              <>
                                <img
                                  src={assignee.avatar}
                                  alt={assignee.name}
                                  className="w-5 h-5 rounded-full object-cover border border-slate-700 shrink-0"
                                />
                                <div className="truncate">
                                  <span className="text-slate-300 text-[11px] font-medium block truncate">
                                    {assignee.name.split(' ')[0]}
                                  </span>
                                  <span className="text-slate-500 text-[9px] block truncate">
                                    {assignee.role.split('&')[0]}
                                  </span>
                                </div>
                              </>
                            ) : (
                              <div className="flex items-center space-x-1 text-slate-500">
                                <Bot className="w-3.5 h-3.5" />
                                <span className="text-[10px]">Unassigned</span>
                              </div>
                            )}
                          </div>

                          {/* Hours and Move Arrows */}
                          <div className="flex items-center space-x-1 shrink-0">
                            <span className="flex items-center text-[10px] text-slate-400 mr-1">
                              <Clock className="w-2.5 h-2.5 mr-0.5 text-slate-500" />
                              {task.spentHours}/{task.estimatedHours}h
                            </span>

                            {/* Back arrow */}
                            {getPrevStatus(task.status) && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const prev = getPrevStatus(task.status);
                                  if (prev) onUpdateTaskStatus(task.id, prev);
                                }}
                                title={`Move back to ${getPrevStatus(task.status)}`}
                                className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                              >
                                <ArrowLeft className="w-3 h-3" />
                              </button>
                            )}

                            {/* Forward arrow */}
                            {getNextStatus(task.status) && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const next = getNextStatus(task.status);
                                  if (next) onUpdateTaskStatus(task.id, next);
                                }}
                                title={`Advance to ${getNextStatus(task.status)}`}
                                className="p-1 rounded hover:bg-indigo-900/50 text-indigo-400 hover:text-indigo-200 transition-colors"
                              >
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
