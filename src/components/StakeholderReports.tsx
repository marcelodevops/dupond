import React, { useState } from 'react';
import { StatusReport, Task, Agent, Epic } from '../types';
import { 
  FileText, 
  Sparkles, 
  Send, 
  Copy, 
  Check, 
  Printer, 
  AlertTriangle, 
  CheckCircle2, 
  RotateCw, 
  Share2, 
  ShieldCheck, 
  TrendingUp,
  Slack
} from 'lucide-react';

interface StakeholderReportsProps {
  tasks: Task[];
  agents: Agent[];
  epics: Epic[];
  onDispatchSlack: (message: string, channel: string) => Promise<boolean>;
}

export const StakeholderReports: React.FC<StakeholderReportsProps> = ({
  tasks,
  agents,
  epics,
  onDispatchSlack,
}) => {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [isDispatchingSlack, setIsDispatchingSlack] = useState(false);
  const [slackDispatchedSuccess, setSlackDispatchedSuccess] = useState(false);

  // Generate new report
  const handleGenerateReport = async () => {
    setIsGenerating(true);
    setSlackDispatchedSuccess(false);
    try {
      const response = await fetch('/api/orchestrate/generate-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks,
          agents,
          epics,
          sprintNumber: 1,
          period: 'Sprint 1 (Active)',
        }),
      });

      const data = await response.json();
      setReport({
        id: `report-${Date.now()}`,
        title: 'Sprint 1 Executive Brief & Engineering Digest',
        period: 'Sprint 1',
        generatedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        executiveSummary: data.executiveSummary,
        metrics: data.metrics || {
          velocity: 38,
          completionRate: Math.round((tasks.filter((t) => t.status === 'done').length / (tasks.length || 1)) * 100),
          blockerCount: 0,
          sprintHealth: 'Green',
        },
        highlights: data.highlights || [],
        risksAndBlockers: data.risksAndBlockers || [],
        nextMilestones: data.nextMilestones || [],
        slackDigest: data.slackDigest || '',
        jiraDigest: data.jiraDigest || '',
      });
    } catch (err) {
      console.error('Failed to generate report:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  // Copy to clipboard helper
  const handleCopy = (text: string, sectionId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(sectionId);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  // Send to Slack
  const handleSendToSlack = async () => {
    if (!report) return;
    setIsDispatchingSlack(true);
    try {
      const success = await onDispatchSlack(report.slackDigest, '#stakeholder-briefs');
      if (success) {
        setSlackDispatchedSuccess(true);
      }
    } finally {
      setIsDispatchingSlack(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Action Header Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg backdrop-blur-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2">
              <FileText className="w-5 h-5 text-indigo-400" />
              <h2 className="text-base font-bold text-slate-100">
                Automated Stakeholder Status Reporting
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
              Generate executive briefs, sprint digests, risk & blocker mitigation forecasts, and ready-to-dispatch Slack / Jira notes for C-suite and Product Stakeholders.
            </p>
          </div>

          <div className="flex items-center space-x-3">
            <button
              onClick={handleGenerateReport}
              disabled={isGenerating}
              className="flex items-center space-x-2 px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 text-white text-xs font-bold rounded-lg shadow-lg shadow-indigo-600/30 transition-all active:scale-95 disabled:opacity-50"
            >
              {isGenerating ? (
                <>
                  <RotateCw className="w-4 h-4 animate-spin" />
                  <span>Synthesizing Report...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 text-indigo-200" />
                  <span>Generate Stakeholder Brief</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Generated Report Display */}
      {report ? (
        <div className="space-y-6">
          {/* Executive Scorecard Header */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-md">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 mb-4 border-b border-slate-800 gap-3">
              <div>
                <span className="text-xs font-semibold text-indigo-400 uppercase tracking-wider">
                  Executive Brief
                </span>
                <h3 className="text-lg font-bold text-slate-100">{report.title}</h3>
                <p className="text-xs text-slate-400">
                  Synthesized by Aegis Orchestrator • {report.generatedAt}
                </p>
              </div>

              {/* Quick Export Actions */}
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => window.print()}
                  className="flex items-center space-x-1.5 px-3 py-1.5 bg-slate-950 border border-slate-800 hover:bg-slate-800 rounded-lg text-xs text-slate-300 transition-colors"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print / PDF</span>
                </button>

                <button
                  onClick={handleSendToSlack}
                  disabled={isDispatchingSlack}
                  className="flex items-center space-x-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow transition-all disabled:opacity-50"
                >
                  {isDispatchingSlack ? (
                    <RotateCw className="w-3.5 h-3.5 animate-spin" />
                  ) : slackDispatchedSuccess ? (
                    <Check className="w-3.5 h-3.5 text-emerald-300" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  <span>{slackDispatchedSuccess ? 'Dispatched to Slack' : 'Dispatch to Slack'}</span>
                </button>
              </div>
            </div>

            {/* 4 KPI Metrics Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
              <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3">
                <span className="text-[10px] text-slate-400 uppercase font-semibold">Sprint Health</span>
                <div className="flex items-center space-x-1.5 mt-1">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      report.metrics.sprintHealth === 'Green'
                        ? 'bg-emerald-400'
                        : report.metrics.sprintHealth === 'Amber'
                        ? 'bg-amber-400'
                        : 'bg-rose-400'
                    }`}
                  />
                  <span className="text-base font-bold text-slate-100">
                    {report.metrics.sprintHealth} (On Track)
                  </span>
                </div>
              </div>

              <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3">
                <span className="text-[10px] text-slate-400 uppercase font-semibold">Progress</span>
                <div className="text-base font-bold text-indigo-400 mt-1">
                  {report.metrics.completionRate}%
                </div>
              </div>

              <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3">
                <span className="text-[10px] text-slate-400 uppercase font-semibold">Sprint Velocity</span>
                <div className="text-base font-bold text-emerald-400 mt-1">
                  {report.metrics.velocity} pts
                </div>
              </div>

              <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3">
                <span className="text-[10px] text-slate-400 uppercase font-semibold">Active Blockers</span>
                <div className="text-base font-bold text-slate-100 mt-1">
                  {report.metrics.blockerCount === 0 ? (
                    <span className="text-emerald-400">0 Blockers</span>
                  ) : (
                    <span className="text-rose-400">{report.metrics.blockerCount} Under Review</span>
                  )}
                </div>
              </div>
            </div>

            {/* Executive Narrative */}
            <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-4 mb-4">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider mb-2">
                Executive Narrative Summary
              </h4>
              <p className="text-xs text-slate-300 leading-relaxed">
                {report.executiveSummary}
              </p>
            </div>

            {/* Highlights & Risks Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Key Achievements */}
              <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-4">
                <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center space-x-1.5 mb-2.5">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Key Sprint Deliverables</span>
                </h4>
                <ul className="space-y-2 text-xs text-slate-300">
                  {report.highlights.map((h, i) => (
                    <li key={i} className="flex items-start space-x-2">
                      <span className="text-emerald-400 font-bold">✓</span>
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Risks & Mitigation */}
              <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-4">
                <h4 className="text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center space-x-1.5 mb-2.5">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Risks & AI Mitigation Directives</span>
                </h4>
                <ul className="space-y-2 text-xs text-slate-300">
                  {report.risksAndBlockers.map((r, i) => (
                    <li key={i} className="flex items-start space-x-2">
                      <span className="text-amber-400 font-bold">!</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Formatted Digests for Slack & Jira */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Slack Block Kit Preview */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-800">
                <div className="flex items-center space-x-2">
                  <div className="w-6 h-6 rounded bg-emerald-600 flex items-center justify-center text-white text-xs font-bold">
                    #
                  </div>
                  <span className="text-xs font-bold text-slate-100">
                    Slack #stakeholder-briefs Digest
                  </span>
                </div>
                <button
                  onClick={() => handleCopy(report.slackDigest, 'slack')}
                  className="flex items-center space-x-1 text-xs text-slate-400 hover:text-white"
                >
                  {copiedSection === 'slack' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedSection === 'slack' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>

              <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-[11px] text-slate-300 font-mono whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto">
                {report.slackDigest}
              </pre>
            </div>

            {/* Jira Release Notes Format */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-800">
                <div className="flex items-center space-x-2">
                  <div className="w-6 h-6 rounded bg-blue-600 flex items-center justify-center text-white text-xs font-bold">
                    J
                  </div>
                  <span className="text-xs font-bold text-slate-100">
                    Atlassian Jira Sprint Release Digest
                  </span>
                </div>
                <button
                  onClick={() => handleCopy(report.jiraDigest, 'jira')}
                  className="flex items-center space-x-1 text-xs text-slate-400 hover:text-white"
                >
                  {copiedSection === 'jira' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedSection === 'jira' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>

              <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-[11px] text-slate-300 font-mono whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto">
                {report.jiraDigest}
              </pre>
            </div>
          </div>
        </div>
      ) : (
        /* Empty State */
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-12 text-center flex flex-col items-center justify-center space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-indigo-950/60 border border-indigo-800/40 flex items-center justify-center text-indigo-400">
            <FileText className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-100">No Stakeholder Brief Generated Yet</h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
              Click the "Generate Stakeholder Brief" button above. Aegis will aggregate the real-time Kanban board status, milestones, velocity, and generate C-suite and engineering notes.
            </p>
          </div>
          <button
            onClick={handleGenerateReport}
            className="flex items-center space-x-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg shadow"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Generate Now</span>
          </button>
        </div>
      )}
    </div>
  );
};
