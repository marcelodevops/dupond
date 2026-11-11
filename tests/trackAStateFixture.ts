/**
 * Import this BEFORE anything that touches the coordinator: it points the
 * server state file at a throwaway directory and seeds it with credentials that
 * are obviously fake, so the credential tests can assert on real values without
 * writing a token-shaped string into data/dupond_state.json.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-tracka-state-'));
export const STATE_FILE = path.join(STATE_DIR, 'dupond_state.json');

export const SENTINELS = {
  jiraApiToken: 'SENTINEL-jira-api-token-must-never-leave-the-server',
  userEmail: 'orchestrator@example.com',
  slackWebhookUrl: 'https://hooks.slack.com/services/T000/B000/SENTINEL-webhook-key',
  repositoryApiToken: 'SENTINEL-repository-api-token',
  providerApiKey: 'SENTINEL-provider-api-key-header',
};

/**
 * The subset that must never reach a client. userEmail is excluded deliberately:
 * it is an identity the integrations form needs to render, not a bearer secret.
 */
export const SENTINEL_SECRETS: string[] = [
  SENTINELS.jiraApiToken,
  SENTINELS.slackWebhookUrl,
  SENTINELS.repositoryApiToken,
  SENTINELS.providerApiKey,
];

function seed(): void {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const shippedPath = path.join(repoRoot, 'data', 'dupond_state.json');

  // Start from the shipped shape when present so the section-missing case is
  // exercised too, otherwise fall back to a hand-built config.
  let base: Record<string, any> = {};
  if (fs.existsSync(shippedPath)) {
    try {
      base = JSON.parse(fs.readFileSync(shippedPath, 'utf-8'));
    } catch {
      base = {};
    }
  }

  const integration = base.integrationConfig ?? {};
  const customProviders = Array.isArray(integration.customProviders) ? [...integration.customProviders] : [];
  const sentinelProvider = {
    id: 'prov-sentinel',
    name: 'Sentinel provider',
    endpointUrl: 'https://provider.example.invalid/hooks/dupond',
    providerType: 'webhook' as const,
    active: true,
    apiKeyHeader: SENTINELS.providerApiKey,
  };
  if (customProviders.length === 0) customProviders.push(sentinelProvider);
  else customProviders[0] = { ...customProviders[0], ...sentinelProvider };

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      ...base,
      integrationConfig: {
        ...integration,
        jira: {
          ...integration.jira,
          hostUrl: integration.jira?.hostUrl ?? 'https://acme-enterprise.atlassian.net',
          projectKey: integration.jira?.projectKey ?? 'AEG',
          userEmail: SENTINELS.userEmail,
          apiToken: SENTINELS.jiraApiToken,
        },
        slack: { ...integration.slack, webhookUrl: SENTINELS.slackWebhookUrl, channel: '#sprint' },
        // The shipped file predates this section; seed it so masking is asserted
        // against a stored token rather than a missing one.
        repository: {
          ...integration.repository,
          enabled: integration.repository?.enabled ?? false,
          type: integration.repository?.type ?? 'local_directory',
          localWriteMode: integration.repository?.localWriteMode ?? 'patch_export',
          targetDirectory: integration.repository?.targetDirectory ?? 'src/services',
          apiToken: SENTINELS.repositoryApiToken,
        },
        customProviders,
      },
    }),
    'utf-8',
  );
}

seed();
process.env.DUPOND_STATE_FILE = STATE_FILE;
