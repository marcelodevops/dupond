import React, { useState } from 'react';
import { Task, Agent, Epic } from '../types';
import { 
  GitGraph, 
  Calendar, 
  TrendingDown, 
  BarChart3, 
  CheckCircle2, 
  Clock, 
  Layers, 
  AlertTriangle,
  ZoomIn,
  ZoomOut,
  Info
} from 'lucide-react';

interface DiagramsProgressProps {
  tasks: Task[];
  agents: Agent[];
  epics: Epic[];
  onTaskClick: (task: Task) => void;
}

export const DiagramsProgress: React.FC<DiagramsProgressProps> = ({
  tasks,
  agents,
  epics,
  onTaskClick,
}) => {
  const [activeDiagram, setActiveDiagram] = useState<'dag' | 'gantt' | 'burndown' | 'velocity'>('dag');
  const [selectedDagTaskId, setSelectedDagTaskId] = useState<string | null>(null);

  // Status color mapping helper
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'done':
        return { bg: '#10B981', border: '#059669', text: 'text-emerald-400' };
      case 'review':
        return { bg: '#F59E0B', border: '#D97706', text: 'text-amber-400' };
      case 'in_progress':
        return { bg: '#6366F1', border: '#4F46E5', text: 'text-indigo-400' };
      case 'todo':
        return { bg: '#3B82F6', border: '#2563EB', text: 'text-blue-400' };
      default:
        return { bg: '#475569', border: '#334155', text: 'text-slate-400' };
    }
  };

  // DAG Layout Calculation (topological level assignment)
  const computeDagLayout = () => {
    const levels: Record<string, number> = {};

    // Determine level of each task based on longest dependency chain
    const getLevel = (taskId: string, visited: Set<string> = new Set()): number => {
      if (visited.has(taskId)) return 0;
      visited.add(taskId);

      const task = tasks.find((t) => t.id === taskId);
      if (!task || !task.dependencies || task.dependencies.length === 0) {
        return 0;
      }

      let maxDepLevel = 0;
      task.dependencies.forEach((depId) => {
        const depLvl = getLevel(depId, new Set(visited));
        if (depLvl + 1 > maxDepLevel) {
          maxDepLevel = depLvl + 1;
        }
      });
      return maxDepLevel;
    };

    tasks.forEach((t) => {
      levels[t.id] = getLevel(t.id);
    });

    // Group tasks by level
    const levelGroups: Record<number, Task[]> = {};
    Object.entries(levels).forEach(([taskId, lvl]) => {
      if (!levelGroups[lvl]) levelGroups[lvl] = [];
      const task = tasks.find((t) => t.id === taskId);
      if (task) levelGroups[lvl].push(task);
    });

    const nodePositions: Record<string, { x: number; y: number; level: number }> = {};
    const colWidth = 220;
    const rowHeight = 110;
    const startX = 60;
    const startY = 60;

    Object.entries(levelGroups).forEach(([lvlStr, groupTasks]) => {
      const lvl = parseInt(lvlStr, 10);
      groupTasks.forEach((task, index) => {
        const yOffset = (groupTasks.length - 1) * 0.5 * rowHeight;
        nodePositions[task.id] = {
          x: startX + lvl * colWidth,
          y: startY + index * rowHeight + (groupTasks.length > 2 ? 0 : 30),
          level: lvl,
        };
      });
    });

    return nodePositions;
  };

  const dagPositions = computeDagLayout();
  const maxDagX = Math.max(...Object.values(dagPositions).map((p) => p.x), 500) + 240;
  const maxDagY = Math.max(...Object.values(dagPositions).map((p) => p.y), 350) + 120;

  // Total sprint story points / hours computation
  const totalHours = tasks.reduce((sum, t) => sum + (t.estimatedHours || 0), 0);
  const doneHours = tasks.filter((t) => t.status === 'done').reduce((sum, t) => sum + (t.estimatedHours || 0), 0);
  const remainingHours = totalHours - doneHours;

  return (
    <div className="space-y-4">
      {/* Visual Navigation Sub-bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/90 border border-slate-800 rounded-xl p-3 shadow-md backdrop-blur-sm">
        <div className="flex items-center space-x-1.5 overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveDiagram('dag')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeDiagram === 'dag'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/80'
            }`}
          >
            <GitGraph className="w-3.5 h-3.5" />
            <span>DAG Dependency Flow</span>
          </button>

          <button
            onClick={() => setActiveDiagram('gantt')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeDiagram === 'gantt'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/80'
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>Sprint Gantt Timeline</span>
          </button>

          <button
            onClick={() => setActiveDiagram('burndown')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeDiagram === 'burndown'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/80'
            }`}
          >
            <TrendingDown className="w-3.5 h-3.5" />
            <span>Sprint Burndown</span>
          </button>

          <button
            onClick={() => setActiveDiagram('velocity')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeDiagram === 'velocity'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/80'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span>Velocity & Allocation</span>
          </button>
        </div>

        {/* Sprint Summary Pill */}
        <div className="flex items-center space-x-3 text-xs text-slate-300">
          <span className="flex items-center space-x-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>Done: <strong className="text-white">{doneHours}h</strong></span>
          </span>
          <span className="flex items-center space-x-1">
            <span className="w-2 h-2 rounded-full bg-indigo-400" />
            <span>Remaining: <strong className="text-white">{remainingHours}h</strong></span>
          </span>
          <span className="text-slate-500">|</span>
          <span className="text-slate-400 font-mono">
            {Math.round((doneHours / (totalHours || 1)) * 100)}% Complete
          </span>
        </div>
      </div>

      {/* Main Diagram Area */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 sm:p-6 shadow-md backdrop-blur-sm min-h-[560px]">
        {/* DIAGRAM 1: Interactive DAG Dependency Flow */}
        {activeDiagram === 'dag' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-800 gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
                  <GitGraph className="w-4 h-4 text-indigo-400" />
                  <span>Directed Acyclic Graph (DAG) & Dependency Flow</span>
                </h3>
                <p className="text-xs text-slate-400">
                  Visual mapping of architectural prerequisites, execution stages, and critical path blocking nodes.
                </p>
              </div>

              {/* Legend */}
              <div className="flex items-center space-x-2 text-[11px] text-slate-400">
                <span className="flex items-center space-x-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  <span>Done</span>
                </span>
                <span className="flex items-center space-x-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                  <span>In Progress</span>
                </span>
                <span className="flex items-center space-x-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                  <span>Review</span>
                </span>
                <span className="flex items-center space-x-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                  <span>To Do</span>
                </span>
              </div>
            </div>

            {/* SVG Canvas for DAG Graph */}
            <div className="w-full overflow-x-auto overflow-y-auto bg-slate-950/80 rounded-xl border border-slate-800/80 p-4">
              <svg
                width={maxDagX}
                height={maxDagY}
                className="select-none"
                style={{ minWidth: '100%' }}
              >
                <defs>
                  {/* Arrowhead marker definition */}
                  <marker
                    id="dag-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#6366F1" />
                  </marker>
                  <marker
                    id="dag-arrow-done"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#10B981" />
                  </marker>
                </defs>

                {/* Draw Bezier dependency connectors */}
                {tasks.map((task) => {
                  const toPos = dagPositions[task.id];
                  if (!toPos) return null;

                  return (task.dependencies || []).map((depId) => {
                    const fromPos = dagPositions[depId];
                    if (!fromPos) return null;

                    const depTask = tasks.find((t) => t.id === depId);
                    const isDepDone = depTask?.status === 'done';

                    const startX = fromPos.x + 160;
                    const startY = fromPos.y + 35;
                    const endX = toPos.x;
                    const endY = toPos.y + 35;
                    const midX = (startX + endX) / 2;

                    const pathData = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;

                    return (
                      <g key={`${depId}-${task.id}`}>
                        <path
                          d={pathData}
                          fill="none"
                          stroke={isDepDone ? '#10B981' : '#6366F1'}
                          strokeWidth="2"
                          strokeDasharray={isDepDone ? 'none' : '4 4'}
                          markerEnd={isDepDone ? 'url(#dag-arrow-done)' : 'url(#dag-arrow)'}
                          className="opacity-70 hover:opacity-100 transition-opacity"
                        />
                      </g>
                    );
                  });
                })}

                {/* Draw Task Nodes */}
                {tasks.map((task) => {
                  const pos = dagPositions[task.id];
                  if (!pos) return null;

                  const statusColor = getStatusColor(task.status);
                  const assignee = agents.find((a) => a.id === task.assignedAgentId);
                  const isSelected = selectedDagTaskId === task.id;

                  return (
                    <g
                      key={task.id}
                      transform={`translate(${pos.x}, ${pos.y})`}
                      onClick={() => {
                        setSelectedDagTaskId(task.id);
                        onTaskClick(task);
                      }}
                      className="cursor-pointer group"
                    >
                      {/* Node Box */}
                      <rect
                        width="160"
                        height="70"
                        rx="10"
                        fill="#0F172A"
                        stroke={isSelected ? '#818CF8' : statusColor.border}
                        strokeWidth={isSelected ? '2.5' : '1.5'}
                        className="transition-all duration-200 drop-shadow-md group-hover:fill-slate-900"
                      />

                      {/* Status indicator bar on left */}
                      <rect
                        x="0"
                        y="0"
                        width="4"
                        height="70"
                        rx="2"
                        fill={statusColor.bg}
                      />

                      {/* Key & Priority */}
                      <text
                        x="12"
                        y="18"
                        fill="#818CF8"
                        fontSize="10"
                        fontWeight="bold"
                        fontFamily="monospace"
                      >
                        {task.key}
                      </text>
                      <text
                        x="148"
                        y="18"
                        textAnchor="end"
                        fill="#94A3B8"
                        fontSize="9"
                        fontWeight="600"
                        className="uppercase"
                      >
                        {task.priority}
                      </text>

                      {/* Title */}
                      <text
                        x="12"
                        y="34"
                        fill="#F8FAFC"
                        fontSize="11"
                        fontWeight="600"
                        className="truncate"
                      >
                        {task.title.length > 20 ? task.title.slice(0, 18) + '...' : task.title}
                      </text>

                      {/* Subtitle / Assignee */}
                      <text
                        x="12"
                        y="52"
                        fill="#64748B"
                        fontSize="9"
                      >
                        {assignee ? `${assignee.name.split(' ')[0]} • ${task.estimatedHours}h` : `${task.estimatedHours}h`}
                      </text>

                      {/* Status pill */}
                      <rect
                        x="90"
                        y="42"
                        width="60"
                        height="16"
                        rx="4"
                        fill={statusColor.bg}
                        fillOpacity="0.2"
                      />
                      <text
                        x="120"
                        y="53"
                        textAnchor="middle"
                        fill={statusColor.bg}
                        fontSize="9"
                        fontWeight="bold"
                      >
                        {task.status.toUpperCase()}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        )}

        {/* DIAGRAM 2: Sprint Gantt & Milestone Timeline */}
        {activeDiagram === 'gantt' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-800 gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
                  <Calendar className="w-4 h-4 text-indigo-400" />
                  <span>Sprint Gantt Timeline & Milestone Schedule</span>
                </h3>
                <p className="text-xs text-slate-400">
                  Sprint days 1 to 14 timeline tracking sequence, dependencies, and agent deliverables.
                </p>
              </div>
              <div className="text-xs text-slate-400">
                Sprint 1: <strong className="text-slate-200">14 Business Days</strong>
              </div>
            </div>

            {/* Gantt Timeline Grid */}
            <div className="overflow-x-auto bg-slate-950/80 rounded-xl border border-slate-800 p-4">
              <div className="min-w-[700px] space-y-3">
                {/* Day Header Row */}
                <div className="grid grid-cols-16 text-[10px] text-slate-400 font-mono pb-2 border-b border-slate-800">
                  <div className="col-span-4 font-sans font-semibold text-slate-300">Task & Assignee</div>
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="text-center border-l border-slate-800/80">
                      Day {i + 1}
                    </div>
                  ))}
                </div>

                {/* Task Bars */}
                {tasks.map((task, idx) => {
                  const assignee = agents.find((a) => a.id === task.assignedAgentId);
                  const startDay = Math.min(10, Math.max(1, (idx * 2) % 8 + 1));
                  const durationDays = Math.min(4, Math.max(2, Math.ceil((task.estimatedHours || 6) / 4)));
                  const colStart = 4 + startDay;
                  const colSpan = Math.min(12 - startDay + 1, durationDays);

                  const isDone = task.status === 'done';
                  const isInProgress = task.status === 'in_progress';

                  return (
                    <div
                      key={task.id}
                      onClick={() => onTaskClick(task)}
                      className="grid grid-cols-16 items-center py-1.5 hover:bg-slate-900/60 rounded px-1 transition-colors cursor-pointer group"
                    >
                      {/* Task Info */}
                      <div className="col-span-4 pr-2 flex items-center space-x-2">
                        <span className="font-mono text-[10px] font-bold text-indigo-400 shrink-0">
                          {task.key}
                        </span>
                        <span className="text-xs text-slate-200 truncate group-hover:text-indigo-300 transition-colors">
                          {task.title}
                        </span>
                      </div>

                      {/* Timeline Bar Space */}
                      <div className="col-span-12 relative h-7 bg-slate-900/40 rounded border border-slate-800/50 flex items-center">
                        <div
                          className={`absolute h-6 rounded px-2 flex items-center justify-between text-[10px] font-semibold text-white shadow transition-all ${
                            isDone
                              ? 'bg-gradient-to-r from-emerald-600 to-teal-600'
                              : isInProgress
                              ? 'bg-gradient-to-r from-indigo-600 to-indigo-500 animate-pulse'
                              : 'bg-gradient-to-r from-slate-700 to-slate-800 border border-slate-700'
                          }`}
                          style={{
                            left: `${((startDay - 1) / 12) * 100}%`,
                            width: `${(colSpan / 12) * 100}%`,
                          }}
                        >
                          <span className="truncate">{task.estimatedHours}h</span>
                          {assignee && (
                            <img
                              src={assignee.avatar}
                              alt={assignee.name}
                              className="w-4 h-4 rounded-full border border-white/40 shrink-0 ml-1"
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* DIAGRAM 3: Sprint Burndown Chart */}
        {activeDiagram === 'burndown' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-800 gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
                  <TrendingDown className="w-4 h-4 text-indigo-400" />
                  <span>Sprint Burndown (Ideal vs Real-Time Velocity)</span>
                </h3>
                <p className="text-xs text-slate-400">
                  Tracking story points remaining across sprint timeline against ideal burn trajectory.
                </p>
              </div>
              <div className="flex items-center space-x-4 text-xs">
                <span className="flex items-center space-x-1.5 text-slate-400">
                  <span className="w-4 h-0.5 bg-slate-500 border-dashed border-b" />
                  <span>Ideal Trajectory</span>
                </span>
                <span className="flex items-center space-x-1.5 text-indigo-400 font-semibold">
                  <span className="w-4 h-0.5 bg-indigo-500" />
                  <span>Actual Burn</span>
                </span>
              </div>
            </div>

            {/* SVG Burndown Graph */}
            <div className="bg-slate-950/80 rounded-xl border border-slate-800 p-4">
              <svg viewBox="0 0 700 280" className="w-full h-64">
                {/* Horizontal grid lines */}
                {[0, 25, 50, 75, 100].map((pct, idx) => {
                  const y = 240 - (pct / 100) * 200;
                  return (
                    <g key={idx}>
                      <line x1="50" y1={y} x2="680" y2={y} stroke="#334155" strokeWidth="0.5" strokeDasharray="3 3" />
                      <text x="40" y={y + 4} textAnchor="end" fill="#64748B" fontSize="10">
                        {Math.round((pct / 100) * totalHours)}h
                      </text>
                    </g>
                  );
                })}

                {/* Day labels on X axis */}
                {Array.from({ length: 14 }).map((_, d) => {
                  const x = 50 + (d / 13) * 630;
                  return (
                    <text key={d} x={x} y="260" textAnchor="middle" fill="#94A3B8" fontSize="10">
                      D{d + 1}
                    </text>
                  );
                })}

                {/* Ideal Burndown line (From Total Hours at D1 to 0 at D14) */}
                <line
                  x1="50"
                  y1="40"
                  x2="680"
                  y2="240"
                  stroke="#64748B"
                  strokeWidth="2"
                  strokeDasharray="6 4"
                />

                {/* Actual Burndown curve */}
                {/* Simulation points: D1=totalHours, D3=total-8, D5=total-16, D7=remainingHours */}
                <path
                  d={`M 50 40 L 146 75 L 244 110 L 340 ${240 - (remainingHours / totalHours) * 200}`}
                  fill="none"
                  stroke="#6366F1"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                />

                {/* Current status point */}
                <circle
                  cx="340"
                  cy={240 - (remainingHours / totalHours) * 200}
                  r="6"
                  fill="#6366F1"
                  stroke="#FFFFFF"
                  strokeWidth="2"
                />
                <text
                  x="350"
                  y={240 - (remainingHours / totalHours) * 200 - 10}
                  fill="#818CF8"
                  fontSize="11"
                  fontWeight="bold"
                >
                  Now: {remainingHours}h remaining
                </text>
              </svg>
            </div>
          </div>
        )}

        {/* DIAGRAM 4: Agent Velocity & Allocation Distribution */}
        {activeDiagram === 'velocity' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-800 gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
                  <BarChart3 className="w-4 h-4 text-indigo-400" />
                  <span>Agent Velocity & Sprint Workload Distribution</span>
                </h3>
                <p className="text-xs text-slate-400">
                  Allocated hours against 40-hour capacity buffer per specialist agent.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {agents.map((agent) => {
                const agentTasks = tasks.filter((t) => t.assignedAgentId === agent.id);
                const assignedHours = agentTasks.reduce((sum, t) => sum + (t.estimatedHours || 0), 0);
                const maxCapacity = 40;
                const loadPct = Math.round((assignedHours / maxCapacity) * 100);

                return (
                  <div
                    key={agent.id}
                    className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <img
                          src={agent.avatar}
                          alt={agent.name}
                          className="w-9 h-9 rounded-full object-cover border border-slate-700"
                        />
                        <div>
                          <h4 className="text-xs font-bold text-slate-100">{agent.name}</h4>
                          <p className="text-[11px] text-slate-400">{agent.role}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-xs font-bold text-slate-100">{assignedHours}h</span>
                        <span className="text-[10px] text-slate-500 block">/ {maxCapacity}h</span>
                      </div>
                    </div>

                    {/* Capacity load bar */}
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                        <span>Sprint Load</span>
                        <span className={loadPct > 85 ? 'text-rose-400 font-bold' : 'text-slate-300'}>
                          {loadPct}%
                        </span>
                      </div>
                      <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                        <div
                          className={`h-2 rounded-full transition-all duration-300 ${
                            loadPct > 85
                              ? 'bg-rose-500'
                              : loadPct < 40
                              ? 'bg-cyan-500'
                              : 'bg-emerald-500'
                          }`}
                          style={{ width: `${Math.min(100, loadPct)}%` }}
                        />
                      </div>
                    </div>

                    {/* Assigned task keys */}
                    <div className="flex flex-wrap gap-1">
                      {agentTasks.map((t) => (
                        <span
                          key={t.id}
                          onClick={() => onTaskClick(t)}
                          className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] font-mono text-indigo-300 hover:border-indigo-500 cursor-pointer"
                        >
                          {t.key} ({t.status})
                        </span>
                      ))}
                      {agentTasks.length === 0 && (
                        <span className="text-[10px] text-slate-500 italic">No tasks currently assigned</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
