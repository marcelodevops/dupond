import React, { useState } from 'react';
import { OrchestratorConfig, AutonomyMode, ReasoningLevel, RiskTolerance, CustomProvider } from '../types';
import { 
  Sliders, 
  Bot, 
  Shield, 
  Cpu, 
  Terminal, 
  Check, 
  Plus, 
  Trash2, 
  Send, 
  Sparkles, 
  RotateCw,
  Zap
} from 'lucide-react';

interface OrchestratorStudioProps {
  config: OrchestratorConfig;
  onUpdateConfig: (updated: OrchestratorConfig) => void;
  customProviders: CustomProvider[];
}

export const OrchestratorStudio: React.FC<OrchestratorStudioProps> = ({
  config,
  onUpdateConfig,
  customProviders,
}) => {
  const [formData, setFormData] = useState<OrchestratorConfig>({ ...config });
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [newRuleInput, setNewRuleInput] = useState('');

  // Terminal chat with Orchestrator
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalLogs, setTerminalLogs] = useState<{ sender: 'user' | 'orchestrator'; text: string; time: string }[]>([
    {
      sender: 'orchestrator',
      text: 'Aegis Prime Core initialized. Directives loaded. Standing by for strategic inputs or autonomous execution command.',
      time: '10:00 AM',
    },
  ]);
  const [isTerminalSending, setIsTerminalSending] = useState(false);

  const handleSave = () => {
    onUpdateConfig(formData);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const handleAddRule = () => {
    if (!newRuleInput.trim()) return;
    setFormData({
      ...formData,
      delegationRules: [...formData.delegationRules, newRuleInput.trim()],
    });
    setNewRuleInput('');
  };

  const handleRemoveRule = (index: number) => {
    const updated = [...formData.delegationRules];
    updated.splice(index, 1);
    setFormData({ ...formData, delegationRules: updated });
  };

  const handleSendTerminalDirective = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!terminalInput.trim()) return;

    const userMessage = terminalInput.trim();
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    setTerminalLogs((prev) => [...prev, { sender: 'user', text: userMessage, time: now }]);
    setTerminalInput('');
    setIsTerminalSending(true);

    try {
      // Simulate orchestrator acknowledging directive or query
      setTimeout(() => {
        setTerminalLogs((prev) => [
          ...prev,
          {
            sender: 'orchestrator',
            text: `Directive acknowledged: "${userMessage}". Integrating into real-time delegation weighting matrix. Autonomy mode is set to ${formData.autonomyMode}.`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
        setIsTerminalSending(false);
      }, 700);
    } catch {
      setIsTerminalSending(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg backdrop-blur-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2">
              <Sliders className="w-5 h-5 text-indigo-400" />
              <h2 className="text-base font-bold text-slate-100">
                Orchestrator Agent Persona & Behavior Studio
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
              Full control over the intelligence, autonomy level, risk tolerance, system prompt directives, and delegation algorithms of the Chief Orchestrator.
            </p>
          </div>

          <button
            onClick={handleSave}
            className="flex items-center space-x-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg shadow-md transition-all active:scale-95"
          >
            {savedSuccess ? <Check className="w-4 h-4 text-emerald-300" /> : <Sparkles className="w-4 h-4" />}
            <span>{savedSuccess ? 'Configuration Saved!' : 'Save Directives'}</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Form Controls (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4 shadow-sm">
            <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
              <Bot className="w-4 h-4 text-indigo-400" />
              <span>Persona & Cognitive Parameters</span>
            </h3>

            {/* Persona Name & Model */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Orchestrator Persona Name
                </label>
                <input
                  type="text"
                  value={formData.personaName}
                  onChange={(e) => setFormData({ ...formData, personaName: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  AI Model / Provider
                </label>
                <select
                  value={formData.model}
                  onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="gemini-3.8-flash">Google Gemini 3.8 Flash (High Velocity)</option>
                  {customProviders.map((prov) => (
                    <option key={prov.id} value={`custom:${prov.id}`}>
                      Custom: {prov.name} ({prov.providerType})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* System Prompt / Master Directives */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                System Prompt & Orchestrator Directives
              </label>
              <textarea
                value={formData.systemPrompt}
                onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
                rows={4}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 leading-relaxed font-mono"
              />
            </div>

            {/* Autonomy Mode, Reasoning & Risk */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Autonomy Mode */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Autonomy Mode
                </label>
                <select
                  value={formData.autonomyMode}
                  onChange={(e) => setFormData({ ...formData, autonomyMode: e.target.value as AutonomyMode })}
                  className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="semi_autonomous">Semi-Autonomous (Recommended)</option>
                  <option value="full_autonomous">Full Autonomous</option>
                  <option value="step_by_step">Step-by-Step Approval</option>
                </select>
              </div>

              {/* Reasoning Level */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Reasoning Depth
                </label>
                <select
                  value={formData.reasoningLevel}
                  onChange={(e) => setFormData({ ...formData, reasoningLevel: e.target.value as ReasoningLevel })}
                  className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="deep_thinking">Deep Thinking (High Precision)</option>
                  <option value="standard">Standard (Low Latency)</option>
                </select>
              </div>

              {/* Risk Tolerance */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Risk Tolerance
                </label>
                <select
                  value={formData.riskTolerance}
                  onChange={(e) => setFormData({ ...formData, riskTolerance: e.target.value as RiskTolerance })}
                  className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="conservative">Conservative (Strict Gates)</option>
                  <option value="balanced">Balanced</option>
                  <option value="aggressive">Aggressive Velocity</option>
                </select>
              </div>
            </div>

            {/* Quality & Safety Checkboxes */}
            <div className="pt-2 border-t border-slate-800/80 space-y-2">
              <label className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.requireHumanApprovalForCritical}
                  onChange={(e) => setFormData({ ...formData, requireHumanApprovalForCritical: e.target.checked })}
                  className="rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500"
                />
                <span>Require human operator approval before deploying Critical Path tasks</span>
              </label>

              <label className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.autoJiraSync}
                  onChange={(e) => setFormData({ ...formData, autoJiraSync: e.target.checked })}
                  className="rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500"
                />
                <span>Automatically sync task state transitions to Atlassian Jira Cloud</span>
              </label>

              <label className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.autoSlackBroadcast}
                  onChange={(e) => setFormData({ ...formData, autoSlackBroadcast: e.target.checked })}
                  className="rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500"
                />
                <span>Broadcast blocker alerts and milestone completions to Slack channels</span>
              </label>
            </div>
          </div>

          {/* Delegation Rules Editor */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-3 shadow-sm">
            <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
              <Shield className="w-4 h-4 text-emerald-400" />
              <span>Delegation & Gatekeeper Rules</span>
            </h3>

            <div className="space-y-2">
              {formData.delegationRules.map((rule, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between bg-slate-950/80 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-300"
                >
                  <span className="flex-1 mr-2 leading-relaxed">
                    <strong className="text-indigo-400 mr-1.5">{idx + 1}.</strong> {rule}
                  </span>
                  <button
                    onClick={() => handleRemoveRule(idx)}
                    className="text-slate-500 hover:text-rose-400 p-1"
                    title="Delete rule"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            {/* Add new rule */}
            <div className="flex items-center space-x-2 pt-2">
              <input
                type="text"
                value={newRuleInput}
                onChange={(e) => setNewRuleInput(e.target.value)}
                placeholder="Add customized delegation policy or constraint..."
                className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                onClick={handleAddRule}
                className="flex items-center space-x-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Live Orchestrator Terminal & Chat (5 cols) */}
        <div className="lg:col-span-5 flex flex-col bg-slate-950 border border-slate-800 rounded-xl p-4 shadow-xl min-h-[500px]">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center space-x-2">
              <Terminal className="w-4 h-4 text-indigo-400" />
              <span className="text-xs font-bold text-slate-200 font-mono">
                Aegis Directives Terminal
              </span>
            </div>
            <span className="flex items-center space-x-1 text-[10px] text-emerald-400 font-mono">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>LIVE REASONING</span>
            </span>
          </div>

          {/* Terminal Logs */}
          <div className="flex-1 overflow-y-auto space-y-3 py-3 font-mono text-xs">
            {terminalLogs.map((log, idx) => (
              <div
                key={idx}
                className={`p-2.5 rounded-lg ${
                  log.sender === 'user'
                    ? 'bg-indigo-950/40 border border-indigo-800/40 text-indigo-200 ml-4'
                    : 'bg-slate-900/90 border border-slate-800 text-slate-300 mr-4'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                  <span className="font-bold">
                    {log.sender === 'user' ? 'Operator' : 'Aegis Core'}
                  </span>
                  <span>{log.time}</span>
                </div>
                <p className="leading-relaxed whitespace-pre-wrap">{log.text}</p>
              </div>
            ))}

            {isTerminalSending && (
              <div className="text-[11px] text-slate-500 animate-pulse flex items-center space-x-1.5 p-2">
                <RotateCw className="w-3 h-3 animate-spin" />
                <span>Orchestrator synthesizing response...</span>
              </div>
            )}
          </div>

          {/* Terminal Input Form */}
          <form onSubmit={handleSendTerminalDirective} className="pt-2 border-t border-slate-800/80 flex items-center space-x-2">
            <input
              type="text"
              value={terminalInput}
              onChange={(e) => setTerminalInput(e.target.value)}
              placeholder="Inject real-time directive or ask Aegis a question..."
              className="flex-1 px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="submit"
              disabled={isTerminalSending || !terminalInput.trim()}
              className="p-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
