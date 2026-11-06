import assert from 'node:assert';
import { coordinator, isMaskedSecret } from '../src/server/coordinator.ts';
import { validateAuthToken, getExpectedToken } from '../src/server/auth.ts';

async function main() {
  console.log('=== RUNNING SECURITY & CORRECTNESS REGRESSION TESTS ===\n');

  // Test 1: updateState returns masked state view (never raw secrets)
  const sentinels = {
    jiraToken: 'super-secret-jira-token-xyz-123',
    slackUrl: 'https://hooks.slack.com/services/T00/B00/SECRET_WEBHOOK_KEY',
  };

  coordinator.updateState({
    integrationConfig: {
      ...coordinator.getState().integrationConfig,
      jira: {
        ...coordinator.getState().integrationConfig.jira,
        apiToken: sentinels.jiraToken,
      },
      slack: {
        ...coordinator.getState().integrationConfig.slack,
        webhookUrl: sentinels.slackUrl,
      },
    },
  });

  const updateResult = coordinator.updateState({
    cycleCount: 10,
  });

  assert.strictEqual(updateResult.success, true);
  assert.ok(isMaskedSecret(updateResult.state.integrationConfig.jira.apiToken), 'updateState returned state must mask Jira token');
  assert.ok(!JSON.stringify(updateResult.state).includes(sentinels.jiraToken), 'updateState return payload must not contain raw Jira token');
  console.log('✔ [PASS] updateState returns masked state view without secret leakage');

  // Test 2: Bulk update cannot mark unverified tasks 'done'
  const unverifiedTask = {
    id: 'test-unverified-task',
    key: 'AEG-999',
    title: 'Unverified Feature',
    description: 'Should not become done without verification',
    epicId: 'epic-1',
    status: 'in_progress' as const,
    priority: 'high' as const,
    assignedAgentId: 'agent-1',
    estimatedHours: 4,
    spentHours: 0,
    dependencies: [],
    subtasks: [{ id: 'st-1', title: 'Criteria 1', completed: false }],
    tags: ['test'],
  };

  coordinator.updateState({
    tasks: [...coordinator.getState().tasks, unverifiedTask],
  });

  // Attempt to bulk-mark it as done
  const badDoneResult = coordinator.updateState({
    tasks: coordinator.getState().tasks.map((t) => t.id === unverifiedTask.id ? { ...t, status: 'done' } : t),
  });

  assert.ok(badDoneResult.rejectedDoneTasks.includes('AEG-999'), 'Bulk done transition must be rejected for unverified task');
  const storedTask = coordinator.getState().tasks.find((t) => t.id === unverifiedTask.id);
  assert.notStrictEqual(storedTask?.status, 'done', 'Task must not be stored as done');
  console.log('✔ [PASS] Bulk state update rejects unauthorized Done transition for unverified task');

  // Test 3: Modifying acceptance criteria invalidates prior verification
  const criteriaModifiedResult = coordinator.updateState({
    tasks: coordinator.getState().tasks.map((t) =>
      t.id === unverifiedTask.id
        ? {
            ...t,
            subtasks: [{ id: 'st-1', title: 'Modified criteria', completed: true }],
            status: 'done' as const,
          }
        : t
    ),
  });

  assert.ok(criteriaModifiedResult.rejectedDoneTasks.includes('AEG-999'), 'Modified criteria must invalidate done transition');
  console.log('✔ [PASS] Changing acceptance criteria invalidates prior completion evidence');

  // Test 4: Auth token validation
  const token = getExpectedToken();
  assert.ok(token && token.length > 10, 'Expected valid token generated');
  assert.strictEqual(validateAuthToken(token), true, 'Valid token accepted');
  assert.strictEqual(validateAuthToken(`Bearer ${token}`), true, 'Bearer token accepted');
  assert.strictEqual(validateAuthToken('invalid-token-123'), false, 'Invalid token rejected');
  assert.strictEqual(validateAuthToken(''), false, 'Empty token rejected');
  assert.strictEqual(validateAuthToken(undefined), false, 'Undefined token rejected');
  console.log('✔ [PASS] Application authentication token validation enforced correctly');

  // Clean up test task
  coordinator.updateState({
    tasks: coordinator.getState().tasks.filter((t) => t.id !== unverifiedTask.id),
  });

  console.log('\n=== ALL SECURITY & CORRECTNESS TESTS PASSED ===');
}

main().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
