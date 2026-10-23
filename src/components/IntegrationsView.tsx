import React, { useState } from 'react';
import { IntegrationConfig, CustomProvider, CommunicationMessage, Task, RepositoryConfig } from '../types';
import { 
  Share2, 
  Send, 
  Check, 
  AlertCircle, 
  Plus, 
  Trash2, 
  RotateCw, 
  Activity, 
  Server, 
  Terminal, 
  CheckCircle2, 
  Link, 
  ExternalLink,
  MessageSquare,
  Folder,
  GitBranch,
  GitPullRequest,
  FolderGit2,
  HardDrive
} from 'lucide-react';

interface IntegrationsViewProps {
  integrationConfig: IntegrationConfig;
  onUpdateIntegrationConfig: (updated: IntegrationConfig) => void;
  communications: CommunicationMessage[];
  tasks: Task[];
}

export const IntegrationsView: React.FC<IntegrationsViewProps> = ({
  integrationConfig,
  onUpdateIntegrationConfig,
  communications,
  tasks,
}) => {
  const [config, setConfig] = useState<IntegrationConfig>({
    ...integrationConfig,
    repository: integrationConfig.repository || {
      enabled: true,
      type: 'local_directory',
      localPath: '/Users/mac/ops/repos/aegis-orchestrator',
      localWriteMode: 'direct_write',
      repoUrl: 'https://github.com/acme-corp/aegis-core-system',
      defaultBranch: 'main',
      branchPrefix: 'aegis/',
      deliveryMode: 'pull_request',
      apiToken: '••••••••••••••••••••••••••••••••',
      targetDirectory: 'src/services',
      autoCreatePrOnDone: false,
      autoWriteToLocalOnDone: true,
      lastPrUrl: 'https://github.com/acme-corp/aegis-core-system/pull/42',
      lastCommitHash: '8bd0157f49a2c38d',
      lastDeliveredPath: '/Users/mac/ops/repos/aegis-orchestrator/src/services/AEG-104_service.ts',
    },
  });
  const [activeTab, setActiveTab] = useState<'repository' | 'jira' | 'slack' | 'custom' | 'bus'>('repository');

  // Destination Repository Test state
  const [isTestingRepo, setIsTestingRepo] = useState(false);
  const [repoTestResult, setRepoTestResult] = useState<any | null>(null);

  // Jira Test state
  const [isTestingJira, setIsTestingJira] = useState(false);
  const [jiraTestResult, setJiraTestResult] = useState<any | null>(null);

  // Slack Test state
  const [isTestingSlack, setIsTestingSlack] = useState(false);
  const [slackTestResult, setSlackTestResult] = useState<any | null>(null);

  // Custom provider test state
  const [pingingProviderId, setPingingProviderId] = useState<string | null>(null);
  const [providerTestResults, setProviderTestResults] = useState<Record<string, any>>({});

  // Add Custom Provider Modal state
  const [showAddProviderModal, setShowAddProviderModal] = useState(false);
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderUrl, setNewProviderUrl] = useState('');
  const [newProviderType, setNewProviderType] = useState<'llm' | 'webhook' | 'agent_rpc' | 'ci_cd'>('llm');

  // Test Destination Repository (Local Directory or Remote Git)
  const handleTestRepo = async (action: 'verify' | 'deliver' = 'verify') => {
    setIsTestingRepo(true);
    setRepoTestResult(null);
    try {
      const sampleTask = tasks[0] || {
        key: 'AEG-104',
        title: 'Implement AI-Driven Workload Balancing',
        description: 'Service contract for workload balancing',
        status: 'done',
        priority: 'high',
      };

      const response = await fetch('/api/integrations/repository/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          repoConfig: config.repository,
          task: sampleTask,
        }),
      });

      const data = await response.json();
      setRepoTestResult(data);

      if (data.targetFilePath) {
        const updated = {
          ...config,
          repository: { ...config.repository, lastDeliveredPath: data.targetFilePath },
        };
        setConfig(updated);
        onUpdateIntegrationConfig(updated);
      } else if (data.prUrl) {
        const updated = {
          ...config,
          repository: { ...config.repository, lastPrUrl: data.prUrl, lastCommitHash: data.commitSha },
        };
        setConfig(updated);
        onUpdateIntegrationConfig(updated);
      }
    } catch (err: any) {
      setRepoTestResult({ error: err.message || 'Repository operation failed' });
    } finally {
      setIsTestingRepo(false);
    }
  };

  // Test Jira sync or verification
  const handleTestJiraSync = async (action: 'verify' | 'sync_task' = 'sync_task') => {
    setIsTestingJira(true);
    setJiraTestResult(null);
    try {
      const sampleTask = tasks[0] || {
        key: 'AEG-101',
        title: 'Establish Schema Contracts',
        status: 'done',
        priority: 'critical',
      };

      const response = await fetch('/api/integrations/jira/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          task: sampleTask,
          hostUrl: config.jira.hostUrl,
          userEmail: config.jira.userEmail,
          apiToken: config.jira.apiToken,
          projectKey: config.jira.projectKey,
        }),
      });

      const data = await response.json();
      setJiraTestResult(data);
    } catch (err: any) {
      setJiraTestResult({ error: err.message || 'Sync failed' });
    } finally {
      setIsTestingJira(false);
    }
  };

  // Test Slack dispatch
  const handleTestSlackDispatch = async () => {
    setIsTestingSlack(true);
    setSlackTestResult(null);
    try {
      const response = await fetch('/api/integrations/slack/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: config.slack.webhookUrl,
          channel: config.slack.channel,
          message: {
            text: `🔔 *Aegis Orchestrator Telemetry Test*\n• Status: All systems nominal\n• Active tasks: ${tasks.length}\n• Timestamp: ${new Date().toLocaleTimeString()}`,
          },
        }),
      });

      const data = await response.json();
      setSlackTestResult(data);
    } catch (err: any) {
      setSlackTestResult({ error: err.message || 'Slack test failed' });
    } finally {
      setIsTestingSlack(false);
    }
  };

  // Test Custom Provider Endpoint
  const handlePingCustomProvider = async (provider: CustomProvider) => {
    setPingingProviderId(provider.id);
    try {
      const response = await fetch('/api/custom-providers/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpointUrl: provider.endpointUrl,
          payload: { prompt: 'Aegis ping probe', timestamp: Date.now() },
        }),
      });

      const data = await response.json();
      setProviderTestResults((prev) => ({ ...prev, [provider.id]: data }));

      // update provider latency in config
      if (data.latencyMs) {
        const updatedProviders = config.customProviders.map((p) =>
          p.id === provider.id ? { ...p, latencyMs: data.latencyMs } : p
        );
        const updatedConfig = { ...config, customProviders: updatedProviders };
        setConfig(updatedConfig);
        onUpdateIntegrationConfig(updatedConfig);
      }
    } catch (err: any) {
      setProviderTestResults((prev) => ({
        ...prev,
        [provider.id]: { success: false, error: err.message },
      }));
    } finally {
      setPingingProviderId(null);
    }
  };

  // Save changes helper
  const handleSaveConfig = () => {
    onUpdateIntegrationConfig(config);
  };

  // Add new custom provider
  const handleAddCustomProvider = () => {
    if (!newProviderName.trim() || !newProviderUrl.trim()) return;
    const newProv: CustomProvider = {
      id: `prov-${Date.now()}`,
      name: newProviderName.trim(),
      endpointUrl: newProviderUrl.trim(),
      providerType: newProviderType,
      active: true,
      latencyMs: 120,
    };
    const updated = {
      ...config,
      customProviders: [...config.customProviders, newProv],
    };
    setConfig(updated);
    onUpdateIntegrationConfig(updated);
    setShowAddProviderModal(false);
    setNewProviderName('');
    setNewProviderUrl('');
  };

  const handleDeleteProvider = (id: string) => {
    const updated = {
      ...config,
      customProviders: config.customProviders.filter((p) => p.id !== id),
    };
    setConfig(updated);
    onUpdateIntegrationConfig(updated);
  };

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg backdrop-blur-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2">
              <Share2 className="w-5 h-5 text-indigo-400" />
              <h2 className="text-base font-bold text-slate-100">
                Enterprise Jira, Slack & Custom Providers Hub
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
              Bi-directional synchronization with Atlassian Jira Cloud and Slack. Link external LLM endpoints, custom model APIs (Ollama, vLLM, DeepSeek), and review real-time inter-agent communication messages.
            </p>
          </div>
        </div>

        {/* Integration Sub-tabs */}
        <div className="flex space-x-2 mt-4 pt-3 border-t border-slate-800/80 overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab('repository')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all ${
              activeTab === 'repository'
                ? 'bg-amber-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <FolderGit2 className="w-3.5 h-3.5" />
            <span>Destination Repository & Delivery</span>
          </button>
          <button
            onClick={() => setActiveTab('jira')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'jira'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            Atlassian Jira Sync
          </button>
          <button
            onClick={() => setActiveTab('slack')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'slack'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            Slack Webhooks
          </button>
          <button
            onClick={() => setActiveTab('custom')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'custom'
                ? 'bg-purple-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            Custom Providers & Endpoints ({config.customProviders.length})
          </button>
          <button
            onClick={() => setActiveTab('bus')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'bus'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            Inter-Agent Message Bus ({communications.length})
          </button>
        </div>
      </div>

      {/* TAB 0: DESTINATION REPOSITORY & GIT DELIVERY */}
      {activeTab === 'repository' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-xs font-bold text-slate-100 uppercase tracking-wider flex items-center space-x-2">
                <FolderGit2 className="w-4 h-4 text-amber-400" />
                <span>Destination Repository Configuration</span>
              </h3>
              <label className="flex items-center space-x-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={config.repository.enabled}
                  onChange={(e) => setConfig({ ...config, repository: { ...config.repository, enabled: e.target.checked } })}
                  className="rounded border-slate-700 bg-slate-950 text-amber-500 focus:ring-amber-500/20"
                />
                <span>Enable Delivery</span>
              </label>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Define where autonomous specialist agents deliver verified code artifacts—either directly into a <strong>local repository directory on disk</strong> or to a <strong>remote Git repository (GitHub / GitLab)</strong> via automated Pull Requests.
            </p>

            {/* Target Type Selector */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                Destination Target Type
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, repository: { ...config.repository, type: 'local_directory' } })}
                  className={`flex items-center justify-center space-x-2 p-2.5 rounded-lg border text-xs font-semibold transition-all ${
                    config.repository.type === 'local_directory'
                      ? 'bg-amber-950/40 border-amber-500 text-amber-200 shadow-sm'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <HardDrive className="w-4 h-4 text-amber-400" />
                  <span>Local Repo Directory</span>
                </button>

                <button
                  type="button"
                  onClick={() => setConfig({ ...config, repository: { ...config.repository, type: 'github' } })}
                  className={`flex items-center justify-center space-x-2 p-2.5 rounded-lg border text-xs font-semibold transition-all ${
                    config.repository.type !== 'local_directory'
                      ? 'bg-amber-950/40 border-amber-500 text-amber-200 shadow-sm'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <GitPullRequest className="w-4 h-4 text-amber-400" />
                  <span>Remote Git (GitHub/GitLab)</span>
                </button>
              </div>
            </div>

            {/* LOCAL REPO DIRECTORY FIELDS */}
            {config.repository.type === 'local_directory' ? (
              <div className="space-y-3 bg-slate-950/60 p-3.5 rounded-xl border border-slate-800/80">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    Local Repository Path (Absolute or Relative)
                  </label>
                  <div className="relative">
                    <Folder className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
                    <input
                      type="text"
                      value={config.repository.localPath || ''}
                      onChange={(e) => setConfig({ ...config, repository: { ...config.repository, localPath: e.target.value } })}
                      placeholder="/Users/mac/ops/repos/my-application"
                      className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>
                  <span className="text-[10px] text-slate-500 mt-1 block">
                    Points to your existing codebase on disk where verified files will be written.
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-300 block mb-1">
                      Subdirectory within Repo
                    </label>
                    <input
                      type="text"
                      value={config.repository.targetDirectory || ''}
                      onChange={(e) => setConfig({ ...config, repository: { ...config.repository, targetDirectory: e.target.value } })}
                      placeholder="src/services"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-300 block mb-1">
                      Local Write Strategy
                    </label>
                    <select
                      value={config.repository.localWriteMode === 'git_branch' ? 'patch_export' : (config.repository.localWriteMode || 'patch_export')}
                      onChange={(e) => setConfig({ ...config, repository: { ...config.repository, localWriteMode: e.target.value as any } })}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                    >
                      <option value="patch_export">Export Unified Diff Patch (Safe standalone)</option>
                      <option value="direct_write">Direct File Overwrite (Safe in-tree)</option>
                      <option value="git_branch" disabled>Git Feature Branch (Disabled - pending worktree isolation)</option>
                    </select>
                  </div>
                </div>

                <div className="pt-1">
                  <label className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={config.repository.autoWriteToLocalOnDone ?? true}
                      onChange={(e) => setConfig({ ...config, repository: { ...config.repository, autoWriteToLocalOnDone: e.target.checked } })}
                      className="rounded border-slate-700 bg-slate-950 text-amber-500 focus:ring-amber-500/20"
                    />
                    <span>Automatically write verified code to local directory when task passes Quality Gate</span>
                  </label>
                </div>
              </div>
            ) : (
              /* REMOTE GIT REPO FIELDS */
              <div className="space-y-3 bg-slate-950/60 p-3.5 rounded-xl border border-slate-800/80">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    Remote Repository URL
                  </label>
                  <input
                    type="text"
                    value={config.repository.repoUrl || ''}
                    onChange={(e) => setConfig({ ...config, repository: { ...config.repository, repoUrl: e.target.value } })}
                    placeholder="https://github.com/acme-corp/aegis-core-system"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-300 block mb-1">
                      Target Base Branch
                    </label>
                    <input
                      type="text"
                      value={config.repository.defaultBranch || 'main'}
                      onChange={(e) => setConfig({ ...config, repository: { ...config.repository, defaultBranch: e.target.value } })}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-300 block mb-1">
                      Branch Prefix
                    </label>
                    <input
                      type="text"
                      value={config.repository.branchPrefix || 'aegis/'}
                      onChange={(e) => setConfig({ ...config, repository: { ...config.repository, branchPrefix: e.target.value } })}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-300 block mb-1">
                      Target Subdirectory
                    </label>
                    <input
                      type="text"
                      value={config.repository.targetDirectory || 'src/'}
                      onChange={(e) => setConfig({ ...config, repository: { ...config.repository, targetDirectory: e.target.value } })}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-300 block mb-1">
                      Personal Access Token (PAT)
                    </label>
                    <input
                      type="password"
                      value={config.repository.apiToken || ''}
                      onChange={(e) => setConfig({ ...config, repository: { ...config.repository, apiToken: e.target.value } })}
                      placeholder="ghp_••••••••••••••••••••••••"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                    />
                  </div>
                </div>

                <div className="pt-1">
                  <label className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={config.repository.autoCreatePrOnDone ?? true}
                      onChange={(e) => setConfig({ ...config, repository: { ...config.repository, autoCreatePrOnDone: e.target.checked } })}
                      className="rounded border-slate-700 bg-slate-950 text-amber-500 focus:ring-amber-500/20"
                    />
                    <span>Automatically create Pull Request when task passes Quality Gate</span>
                  </label>
                </div>
              </div>
            )}

            {/* Save & Action Buttons */}
            <div className="pt-2 flex flex-wrap gap-2 justify-between items-center">
              <button
                onClick={handleSaveConfig}
                className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg"
              >
                Save Repository Settings
              </button>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => handleTestRepo('verify')}
                  disabled={isTestingRepo}
                  className="flex items-center space-x-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 text-xs font-semibold rounded-lg border border-amber-800/50 disabled:opacity-50"
                  title="Verify repository destination access"
                >
                  {isTestingRepo ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 text-amber-400" />}
                  <span>Verify Destination</span>
                </button>

                <button
                  onClick={() => handleTestRepo('deliver')}
                  disabled={isTestingRepo}
                  className="flex items-center space-x-1.5 px-3.5 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-lg shadow disabled:opacity-50"
                >
                  {isTestingRepo ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
                  <span>{config.repository.type === 'local_directory' ? 'Deliver to Local Directory' : 'Dispatch Sample PR'}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Repository Diagnostic Results Card */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
                <span className="text-xs font-bold text-slate-200 flex items-center space-x-2">
                  <Activity className="w-4 h-4 text-amber-400" />
                  <span>Repository Destination Status</span>
                </span>
                {repoTestResult && (
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    repoTestResult.success ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'
                  }`}>
                    {repoTestResult.success ? 'READY' : 'ACTION REQUIRED'}
                  </span>
                )}
              </div>

              {repoTestResult ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-300">{repoTestResult.message || 'Operation executed.'}</p>

                  {repoTestResult.targetFilePath && (
                    <div className="p-3 bg-slate-900 border border-slate-800 rounded-lg space-y-1">
                      <span className="text-[10px] uppercase font-bold text-slate-400 block">Delivered File Path:</span>
                      <code className="text-xs text-amber-300 font-mono break-all">{repoTestResult.targetFilePath}</code>
                      <span className="text-[10px] text-slate-500 block">Size: {repoTestResult.bytesWritten} bytes • Task: {repoTestResult.taskKey}</span>
                    </div>
                  )}

                  {repoTestResult.prUrl && (
                    <div className="p-3 bg-slate-900 border border-slate-800 rounded-lg space-y-1">
                      <span className="text-[10px] uppercase font-bold text-slate-400 block">Pull Request Target:</span>
                      <a href={repoTestResult.prUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:underline flex items-center space-x-1 font-mono">
                        <span>{repoTestResult.prUrl}</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <span className="text-[10px] text-slate-400 block">Branch: <code className="text-amber-300 font-mono">{repoTestResult.branch}</code> • Commit: <code className="font-mono text-slate-300">{repoTestResult.commitSha}</code></span>
                    </div>
                  )}

                  {repoTestResult.error && (
                    <div className="p-3 bg-rose-950/40 border border-rose-800/60 rounded-lg text-xs text-rose-300 flex items-start space-x-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                      <span>{repoTestResult.error}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-8 text-center text-slate-500 text-xs space-y-2">
                  <FolderGit2 className="w-8 h-8 mx-auto text-slate-600 opacity-60" />
                  <p>No repository verification run yet.</p>
                  <p className="text-[11px] text-slate-600">Click &ldquo;Verify Destination&rdquo; or &ldquo;Deliver to Local Directory&rdquo; to test your target location.</p>
                </div>
              )}
            </div>

            {/* Current Active Target Summary Footer */}
            <div className="pt-4 border-t border-slate-800/80 mt-4 text-[11px] text-slate-400 flex items-center justify-between">
              <span>Target: <strong className="text-slate-200">{config.repository.type === 'local_directory' ? 'Local Directory' : 'Remote Git'}</strong></span>
              <span className="font-mono text-[10px] text-slate-500 truncate max-w-xs">{config.repository.type === 'local_directory' ? config.repository.localPath : config.repository.repoUrl}</span>
            </div>
          </div>
        </div>
      )}

      {/* TAB 1: JIRA SYNC */}
      {activeTab === 'jira' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-xs font-bold text-slate-100 uppercase tracking-wider flex items-center space-x-2">
                <span className="w-5 h-5 rounded bg-blue-600 flex items-center justify-center text-white text-[11px] font-bold">J</span>
                <span>Jira Cloud API Settings</span>
              </h3>
              <label className="flex items-center space-x-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={config.jira.enabled}
                  onChange={(e) => {
                    const updated = { ...config, jira: { ...config.jira, enabled: e.target.checked } };
                    setConfig(updated);
                    onUpdateIntegrationConfig(updated);
                  }}
                  className="rounded border-slate-700 bg-slate-950 text-indigo-600"
                />
                <span>Active</span>
              </label>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Atlassian Host URL
                </label>
                <input
                  type="text"
                  value={config.jira.hostUrl}
                  onChange={(e) => setConfig({ ...config, jira: { ...config.jira, hostUrl: e.target.value } })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Atlassian User Email
                </label>
                <input
                  type="email"
                  value={config.jira.userEmail || ''}
                  onChange={(e) => setConfig({ ...config, jira: { ...config.jira, userEmail: e.target.value } })}
                  placeholder="developer@yourcompany.com"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    Project Key
                  </label>
                  <input
                    type="text"
                    value={config.jira.projectKey}
                    onChange={(e) => setConfig({ ...config, jira: { ...config.jira, projectKey: e.target.value } })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    API Token (Encrypted)
                  </label>
                  <input
                    type="password"
                    value={config.jira.apiToken}
                    onChange={(e) => setConfig({ ...config, jira: { ...config.jira, apiToken: e.target.value } })}
                    placeholder="Enter Atlassian API Token"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Aegis Inbound Webhook Listener
                </label>
                <input
                  type="text"
                  readOnly
                  value={config.jira.webhookUrl}
                  className="w-full px-3 py-2 bg-slate-950/70 border border-slate-800 rounded-lg text-xs text-slate-400 font-mono"
                />
              </div>
            </div>

            <div className="pt-2 flex flex-wrap gap-2 justify-between items-center">
              <button
                onClick={handleSaveConfig}
                className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg"
              >
                Save Jira Settings
              </button>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => handleTestJiraSync('verify')}
                  disabled={isTestingJira}
                  className="flex items-center space-x-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-sky-300 text-xs font-semibold rounded-lg border border-sky-800/50 disabled:opacity-50"
                  title="Verify Atlassian account authentication"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-sky-400" />
                  <span>Verify Auth</span>
                </button>

                <button
                  onClick={() => handleTestJiraSync('sync_task')}
                  disabled={isTestingJira}
                  className="flex items-center space-x-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg shadow disabled:opacity-50"
                >
                  {isTestingJira ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <Link className="w-3.5 h-3.5" />}
                  <span>Sync Task to Jira</span>
                </button>
              </div>
            </div>
          </div>

          {/* Jira Test Result Card */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
                <span className="text-xs font-bold text-slate-200">
                  Live Jira Payload & Field Mapping Preview
                </span>
                <span className="text-[10px] text-emerald-400 font-mono">
                  BI-DIRECTIONAL SYNC READY
                </span>
              </div>

              {jiraTestResult ? (
                <pre className="bg-slate-900 border border-slate-800 rounded-lg p-3 text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-72 overflow-y-auto">
                  {JSON.stringify(jiraTestResult, null, 2)}
                </pre>
              ) : (
                <div className="text-center py-12 text-xs text-slate-500 space-y-2">
                  <p>Click "Test Jira Sync Probe" to verify ticket creation and state synchronization.</p>
                </div>
              )}
            </div>

            <p className="text-[11px] text-slate-400 pt-3 border-t border-slate-800/80">
              When tasks move to In Progress, Review, or Done on Aegis, status transitions are dispatched immediately to Jira issue keys.
            </p>
          </div>
        </div>
      )}

      {/* TAB 2: SLACK NOTIFICATIONS */}
      {activeTab === 'slack' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-xs font-bold text-slate-100 uppercase tracking-wider flex items-center space-x-2">
                <span className="w-5 h-5 rounded bg-emerald-600 flex items-center justify-center text-white text-[11px] font-bold">#</span>
                <span>Slack Webhook Configuration</span>
              </h3>
              <label className="flex items-center space-x-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={config.slack.enabled}
                  onChange={(e) => {
                    const updated = { ...config, slack: { ...config.slack, enabled: e.target.checked } };
                    setConfig(updated);
                    onUpdateIntegrationConfig(updated);
                  }}
                  className="rounded border-slate-700 bg-slate-950 text-indigo-600"
                />
                <span>Active</span>
              </label>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Incoming Webhook URL
                </label>
                <input
                  type="text"
                  value={config.slack.webhookUrl}
                  onChange={(e) => setConfig({ ...config, slack: { ...config.slack, webhookUrl: e.target.value } })}
                  placeholder="https://hooks.slack.com/services/..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Primary Broadcast Channel
                </label>
                <input
                  type="text"
                  value={config.slack.channel}
                  onChange={(e) => setConfig({ ...config, slack: { ...config.slack, channel: e.target.value } })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                />
              </div>

              <div className="space-y-2 pt-2">
                <span className="text-xs font-semibold text-slate-300 block">
                  Broadcast Triggers:
                </span>
                <label className="flex items-center space-x-2 text-xs text-slate-400">
                  <input
                    type="checkbox"
                    checked={config.slack.notifyOnStatusChange}
                    onChange={(e) => setConfig({ ...config, slack: { ...config.slack, notifyOnStatusChange: e.target.checked } })}
                    className="rounded border-slate-700 bg-slate-950 text-indigo-600"
                  />
                  <span>Task transitions to Review or Done</span>
                </label>

                <label className="flex items-center space-x-2 text-xs text-slate-400">
                  <input
                    type="checkbox"
                    checked={config.slack.notifyOnBlocker}
                    onChange={(e) => setConfig({ ...config, slack: { ...config.slack, notifyOnBlocker: e.target.checked } })}
                    className="rounded border-slate-700 bg-slate-950 text-indigo-600"
                  />
                  <span>Blocker warnings & dependency stalls</span>
                </label>

                <label className="flex items-center space-x-2 text-xs text-slate-400">
                  <input
                    type="checkbox"
                    checked={config.slack.notifyOnCompletion}
                    onChange={(e) => setConfig({ ...config, slack: { ...config.slack, notifyOnCompletion: e.target.checked } })}
                    className="rounded border-slate-700 bg-slate-950 text-indigo-600"
                  />
                  <span>Sprint completion & milestone deliveries</span>
                </label>
              </div>
            </div>

            <div className="pt-2 flex justify-between items-center">
              <button
                onClick={handleSaveConfig}
                className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg"
              >
                Save Slack Config
              </button>

              <button
                onClick={handleTestSlackDispatch}
                disabled={isTestingSlack}
                className="flex items-center space-x-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg shadow disabled:opacity-50"
              >
                {isTestingSlack ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                <span>Send Test Notification</span>
              </button>
            </div>
          </div>

          {/* Slack Live Response Preview */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
                <span className="text-xs font-bold text-slate-200">
                  Slack Dispatch Result & Telemetry
                </span>
                <span className="text-[10px] text-emerald-400 font-mono">
                  ACTIVE WEBHOOK
                </span>
              </div>

              {slackTestResult ? (
                <pre className="bg-slate-900 border border-slate-800 rounded-lg p-3 text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-72 overflow-y-auto">
                  {JSON.stringify(slackTestResult, null, 2)}
                </pre>
              ) : (
                <div className="text-center py-12 text-xs text-slate-500">
                  Click "Send Test Notification" to dispatch a formatted alert to {config.slack.channel}.
                </div>
              )}
            </div>

            <p className="text-[11px] text-slate-400 pt-3 border-t border-slate-800/80">
              Supports both real incoming webhook URLs and internal simulated delivery with latency metrics.
            </p>
          </div>
        </div>
      )}

      {/* TAB 3: CUSTOM PROVIDERS & API ENDPOINTS */}
      {activeTab === 'custom' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                External AI Providers & Custom API Endpoints
              </h3>
              <p className="text-xs text-slate-400">
                Link custom LLM endpoints (e.g. self-hosted Ollama, vLLM, DeepSeek), external agent microservices, or custom CI/CD pipelines.
              </p>
            </div>
            <button
              onClick={() => setShowAddProviderModal(true)}
              className="flex items-center space-x-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-semibold shadow"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Register Custom Endpoint</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {config.customProviders.map((provider) => {
              const isPinging = pingingProviderId === provider.id;
              const result = providerTestResults[provider.id];

              return (
                <div
                  key={provider.id}
                  className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-3"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-2.5">
                      <div className="w-8 h-8 rounded-lg bg-purple-950/60 border border-purple-800/50 flex items-center justify-center text-purple-400">
                        <Server className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-slate-100">{provider.name}</h4>
                        <span className="text-[10px] text-purple-400 bg-purple-950/40 px-1.5 py-0.5 rounded border border-purple-900/40 uppercase font-mono">
                          {provider.providerType}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleDeleteProvider(provider.id)}
                      className="text-slate-500 hover:text-rose-400 p-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* URL */}
                  <div className="bg-slate-950 border border-slate-800/80 rounded px-2.5 py-1.5 text-[11px] font-mono text-slate-300 truncate">
                    {provider.endpointUrl}
                  </div>

                  {/* Latency & Ping action */}
                  <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 text-[11px]">
                    <span className="text-slate-400">
                      Latency: <strong className="text-slate-200">{provider.latencyMs ? `${provider.latencyMs}ms` : 'Not tested'}</strong>
                    </span>

                    <button
                      onClick={() => handlePingCustomProvider(provider)}
                      disabled={isPinging}
                      className="flex items-center space-x-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs transition-colors disabled:opacity-50"
                    >
                      {isPinging ? <RotateCw className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3 text-cyan-400" />}
                      <span>Ping Endpoint</span>
                    </button>
                  </div>

                  {result && (
                    <div className="text-[10px] font-mono p-2 rounded bg-slate-950 border border-slate-800">
                      <span className={result.success ? 'text-emerald-400' : 'text-amber-400'}>
                        {result.success ? '✓ 200 OK' : `Probe result: ${result.error || 'Connected'}`}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 4: INTER-AGENT MESSAGE BUS */}
      {activeTab === 'bus' && (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-xs font-bold text-slate-100 uppercase tracking-wider flex items-center space-x-2">
                <MessageSquare className="w-4 h-4 text-indigo-400" />
                <span>Inter-Agent Communication & Delegation Bus</span>
              </h3>
              <p className="text-xs text-slate-400">
                Live transcript of directives, handoffs, QA verdicts, and dynamic role assumption broadcasts.
              </p>
            </div>
            <span className="text-xs text-slate-400 font-mono">
              {communications.length} Messages Logged
            </span>
          </div>

          <div className="space-y-2.5 max-h-[500px] overflow-y-auto pr-1">
            {communications.map((msg) => (
              <div
                key={msg.id}
                className="bg-slate-950/80 border border-slate-800 rounded-lg p-3 text-xs space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-indigo-300">{msg.senderName}</span>
                    <span className="text-[10px] text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                      {msg.senderRole}
                    </span>
                    <span className="text-slate-600">→</span>
                    <span className="text-[10px] text-slate-300">{msg.recipientId || 'Team'}</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    {msg.taskId && (
                      <span className="font-mono text-[10px] text-indigo-400 bg-indigo-950/60 px-1 rounded border border-indigo-900/40">
                        {msg.taskId}
                      </span>
                    )}
                    <span className="text-[10px] text-slate-500 font-mono">{msg.timestamp}</span>
                  </div>
                </div>
                <p className="text-slate-300 leading-relaxed">{msg.content}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Custom Provider Modal */}
      {showAddProviderModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
                <Server className="w-4 h-4 text-purple-400" />
                <span>Register Custom Provider Endpoint</span>
              </h3>
              <button
                onClick={() => setShowAddProviderModal(false)}
                className="text-slate-400 hover:text-slate-200 text-xs"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Provider Name
                </label>
                <input
                  type="text"
                  value={newProviderName}
                  onChange={(e) => setNewProviderName(e.target.value)}
                  placeholder="e.g. DeepSeek Coder 33B (Ollama)"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Endpoint URL
                </label>
                <input
                  type="text"
                  value={newProviderUrl}
                  onChange={(e) => setNewProviderUrl(e.target.value)}
                  placeholder="http://localhost:11434/api/generate"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Provider Type
                </label>
                <select
                  value={newProviderType}
                  onChange={(e) => setNewProviderType(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="llm">External LLM Model (REST / OpenAI-compatible)</option>
                  <option value="webhook">Custom Event Webhook</option>
                  <option value="agent_rpc">External Agent RPC Subroutine</option>
                  <option value="ci_cd">CI/CD Dispatch Pipeline</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setShowAddProviderModal(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCustomProvider}
                className="px-4 py-1.5 rounded-lg text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white shadow"
              >
                Register Provider
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
