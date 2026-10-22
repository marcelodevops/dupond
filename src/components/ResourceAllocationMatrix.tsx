import React, { useState } from 'react';
import { Agent, Task } from '../types';
import { 
  Users, 
  Sparkles, 
  Brain, 
  CheckCircle, 
  AlertTriangle, 
  ArrowRight, 
  History, 
  Award, 
  RotateCw, 
  ShieldCheck,
  TrendingUp,
  Cpu
} from 'lucide-react';

interface ResourceAllocationMatrixProps {
  agents: Agent[];
  tasks: Task[];
  onRebalanceComplete: (newAssignments: { taskId: string; agentId: string; roleAssumed: string }[]) => void;
  onUpdateAgentRole: (agentId: string, newRole: string, reason: string) => void;
  onTaskClick: (task: Task) => void;
}

export const ResourceAllocationMatrix: React.FC<ResourceAllocationMatrixProps> = ({
  agents,
  tasks,
  onRebalanceComplete,
  onUpdateAgentRole,
  onTaskClick,
}) => {
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizationInsights, setOptimizationInsights] = useState<string[] | null>(null);
  const [selectedAgentForRoleShift, setSelectedAgentForRoleShift] = useState<Agent | null>(null);
  const [customRoleInput, setCustomRoleInput] = useState('');
  const [roleReasonInput, setRoleReasonInput] = useState('');

  // Calculate workload per agent
  const getAgentMetrics = (agent: Agent) => {
    const assignedTasks = tasks.filter((t) => t.assignedAgentId === agent.id);
    const activeTasks = assignedTasks.filter((t) => t.status !== 'done');
    const allocatedHours = assignedTasks.reduce((sum, t) => sum + (t.estimatedHours || 0), 0);
    const activeHours = activeTasks.reduce((sum, t) => sum + (t.estimatedHours || 0), 0);
    const maxCapacity = 40;
    const loadPercentage = Math.round((allocatedHours / maxCapacity) * 100);

    let status: 'underloaded' | 'optimal' | 'overloaded' = 'optimal';
    if (loadPercentage < 40) status = 'underloaded';
    if (loadPercentage > 85) status = 'overloaded';

    return {
      assignedTasks,
      activeTasks,
      allocatedHours,
      activeHours,
      loadPercentage,
      status,
    };
  };

  // Trigger AI-driven allocation optimization
  const handleRunAiAllocation = async () => {
    setIsOptimizing(true);
    try {
      const response = await fetch('/api/orchestrate/allocate-resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks, agents }),
      });

      const data = await response.json();
      if (data.assignments && Array.isArray(data.assignments)) {
        onRebalanceComplete(data.assignments);
      }
      if (data.recommendations) {
        setOptimizationInsights(data.recommendations);
      } else {
        setOptimizationInsights([
          'Workload rebalanced across specialist nodes based on domain skill matching.',
          'Critical path tasks prioritized to reduce sprint idle latency.',
        ]);
      }
    } catch (err) {
      console.error('Failed to run AI allocation:', err);
    } finally {
      setIsOptimizing(false);
    }
  };

  const handleApplyRoleShift = () => {
    if (!selectedAgentForRoleShift || !customRoleInput.trim()) return;
    onUpdateAgentRole(
      selectedAgentForRoleShift.id,
      customRoleInput.trim(),
      roleReasonInput.trim() || 'Role assumed dynamically to resolve project bottleneck.'
    );
    setSelectedAgentForRoleShift(null);
    setCustomRoleInput('');
    setRoleReasonInput('');
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & AI Optimize Action */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg backdrop-blur-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2">
              <Brain className="w-5 h-5 text-indigo-400" />
              <h2 className="text-base font-bold text-slate-100">
                AI-Driven Resource Allocation & Dynamic Role Assumption
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
              Aegis continuously tracks agent workload, domain skills, and communication history. Sub-agents dynamically assume specialized roles (e.g. Architect, Penetration Tester, Design Lead) based on sprint requirements.
            </p>
          </div>

          <button
            onClick={handleRunAiAllocation}
            disabled={isOptimizing}
            className="flex items-center justify-center space-x-2 px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 text-white text-xs font-bold rounded-lg shadow-lg shadow-indigo-600/30 transition-all active:scale-95 disabled:opacity-50"
          >
            {isOptimizing ? (
              <>
                <RotateCw className="w-4 h-4 animate-spin" />
                <span>Optimizing Allocation...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 text-indigo-200" />
                <span>AI Rebalance Workload</span>
              </>
            )}
          </button>
        </div>

        {/* Optimization Insights Pill if present */}
        {optimizationInsights && (
          <div className="mt-4 pt-4 border-t border-slate-800/80">
            <h4 className="text-xs font-semibold text-indigo-300 flex items-center space-x-1.5 mb-2">
              <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
              <span>Orchestrator Allocation Insights:</span>
            </h4>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-300">
              {optimizationInsights.map((insight, idx) => (
                <li key={idx} className="flex items-start space-x-2 bg-slate-950/60 p-2 rounded-lg border border-slate-800/80">
                  <span className="text-indigo-400 font-bold">•</span>
                  <span>{insight}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Agents Matrix Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => {
          const metrics = getAgentMetrics(agent);

          return (
            <div
              key={agent.id}
              className="bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-4 hover:border-slate-700 transition-all shadow-sm"
            >
              {/* Agent Profile & Dynamic Role Badge */}
              <div>
                <div className="flex items-start justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="relative">
                      <img
                        src={agent.avatar}
                        alt={agent.name}
                        className="w-11 h-11 rounded-full object-cover border-2 border-slate-700 shadow"
                      />
                      <span
                        className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-slate-900 ${
                          agent.status === 'working'
                            ? 'bg-emerald-400'
                            : agent.status === 'reviewing'
                            ? 'bg-amber-400'
                            : 'bg-slate-400'
                        }`}
                        title={`Status: ${agent.status}`}
                      />
                    </div>
                    <div>
                      <h3 className="text-xs font-bold text-slate-100 flex items-center space-x-1.5">
                        <span>{agent.name}</span>
                        {agent.providerType === 'gemini' ? (
                          <span className="text-[10px] text-cyan-400 bg-cyan-950/60 px-1 rounded border border-cyan-800/40">
                            Gemini 3.8
                          </span>
                        ) : (
                          <span className="text-[10px] text-purple-400 bg-purple-950/60 px-1 rounded border border-purple-800/40">
                            Custom API
                          </span>
                        )}
                      </h3>
                      <p className="text-[11px] text-indigo-300 font-medium">{agent.role}</p>
                      <p className="text-[10px] text-slate-500">Base: {agent.baseRole}</p>
                    </div>
                  </div>

                  {/* Velocity badge */}
                  <div className="text-right">
                    <span className="text-[10px] text-slate-400 block">Velocity</span>
                    <span className="text-xs font-bold text-emerald-400">
                      {agent.velocity} pts
                    </span>
                  </div>
                </div>

                {/* Capacity & Workload Bar */}
                <div className="mt-3.5 space-y-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-400">
                      Workload: <strong className="text-slate-200">{metrics.allocatedHours}h</strong> / 40h
                    </span>
                    <span
                      className={`font-semibold ${
                        metrics.status === 'overloaded'
                          ? 'text-rose-400'
                          : metrics.status === 'underloaded'
                          ? 'text-cyan-400'
                          : 'text-emerald-400'
                      }`}
                    >
                      {metrics.loadPercentage}% ({metrics.status})
                    </span>
                  </div>
                  <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        metrics.status === 'overloaded'
                          ? 'bg-rose-500'
                          : metrics.status === 'underloaded'
                          ? 'bg-cyan-500'
                          : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(100, metrics.loadPercentage)}%` }}
                    />
                  </div>
                </div>

                {/* Skills tags */}
                <div className="mt-3">
                  <span className="text-[10px] font-semibold text-slate-400 block mb-1">
                    Core Specializations:
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {agent.skills.map((skill, sIdx) => (
                      <span
                        key={sIdx}
                        className="px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 text-[10px] text-slate-300"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Dynamic Role History */}
                {agent.dynamicRoleHistory && agent.dynamicRoleHistory.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-slate-800/80">
                    <span className="text-[10px] font-semibold text-slate-400 flex items-center space-x-1 mb-1">
                      <History className="w-3 h-3 text-indigo-400" />
                      <span>Role Transition History:</span>
                    </span>
                    <div className="space-y-1">
                      {agent.dynamicRoleHistory.slice(-2).map((h, hIdx) => (
                        <div key={hIdx} className="text-[10px] text-slate-400 flex justify-between">
                          <span className="text-indigo-300">↳ {h.role}</span>
                          <span className="text-slate-500 font-mono">{h.taskKey} ({h.timestamp})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Assigned Tasks & Assume Role Button */}
              <div className="pt-3 border-t border-slate-800/80 space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400">Assigned Tasks ({metrics.assignedTasks.length})</span>
                  <button
                    onClick={() => {
                      setSelectedAgentForRoleShift(agent);
                      setCustomRoleInput(agent.role);
                    }}
                    className="text-[10px] text-indigo-400 hover:text-indigo-300 font-medium underline"
                  >
                    Assume Role
                  </button>
                </div>

                <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
                  {metrics.assignedTasks.map((t) => (
                    <span
                      key={t.id}
                      onClick={() => onTaskClick(t)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer border ${
                        t.status === 'done'
                          ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                          : t.status === 'in_progress'
                          ? 'bg-indigo-950/40 border-indigo-800/60 text-indigo-300'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                      title={`${t.title} (${t.status})`}
                    >
                      {t.key}
                    </span>
                  ))}
                  {metrics.assignedTasks.length === 0 && (
                    <span className="text-[10px] text-slate-500 italic">No tasks currently assigned</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal: Dynamic Role Assumption Shift */}
      {selectedAgentForRoleShift && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
                <Cpu className="w-4 h-4 text-indigo-400" />
                <span>Assume Dynamic Role for {selectedAgentForRoleShift.name}</span>
              </h3>
              <button
                onClick={() => setSelectedAgentForRoleShift(null)}
                className="text-slate-400 hover:text-slate-200 text-xs"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Sub-agents dynamically assume roles to match project requirements, compliance hurdles, or team capacity shifts.
            </p>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Target Dynamic Role:
                </label>
                <input
                  type="text"
                  value={customRoleInput}
                  onChange={(e) => setCustomRoleInput(e.target.value)}
                  placeholder="e.g. Lead Penetration Tester & SecOps Auditor"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Reason for Role Shift / Context:
                </label>
                <textarea
                  value={roleReasonInput}
                  onChange={(e) => setRoleReasonInput(e.target.value)}
                  placeholder="e.g. High priority security verification required on auth module before staging deploy."
                  rows={3}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setSelectedAgentForRoleShift(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={handleApplyRoleShift}
                className="px-4 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow"
              >
                Confirm Dynamic Role
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
