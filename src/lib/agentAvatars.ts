const coordinatorAvatar = new URL('../../resources/agents/coordinator.png', import.meta.url).href;
const plannerAvatar = new URL('../../resources/agents/planner.png', import.meta.url).href;
const codingWorkerAvatar = new URL('../../resources/agents/coding-worker.png', import.meta.url).href;
const verifierAvatar = new URL('../../resources/agents/verifier.png', import.meta.url).href;
const reviewerAvatar = new URL('../../resources/agents/reviewer.png', import.meta.url).href;
const deliveryAvatar = new URL('../../resources/agents/delivery.png', import.meta.url).href;

export type CharacterRole =
  | 'coordinator'
  | 'planner'
  | 'coding-worker'
  | 'verifier'
  | 'reviewer'
  | 'delivery'
  | 'unknown';

export const CHARACTER_AVATAR_ASSETS: Record<Exclude<CharacterRole, 'unknown'>, string> = {
  coordinator: coordinatorAvatar,
  planner: plannerAvatar,
  'coding-worker': codingWorkerAvatar,
  verifier: verifierAvatar,
  reviewer: reviewerAvatar,
  delivery: deliveryAvatar,
};

export interface CharacterRoleInfo {
  character: CharacterRole;
  title: string;
  visualDescription: string;
  defaultAlt: string;
  assetUrl: string | null;
}

export const CHARACTER_ROLE_DETAILS: Record<CharacterRole, Omit<CharacterRoleInfo, 'character' | 'assetUrl'>> = {
  coordinator: {
    title: 'Coordinator',
    visualDescription: 'Dupond with bowler hat and moustache',
    defaultAlt: 'Dupond, the bowler-hatted coordinator',
  },
  planner: {
    title: 'Planner',
    visualDescription: 'Cream robot holding a parchment map',
    defaultAlt: 'Planner robot studying a map',
  },
  'coding-worker': {
    title: 'Coding Worker',
    visualDescription: 'Cream robot behind a laptop',
    defaultAlt: 'Coding worker robot behind a laptop',
  },
  verifier: {
    title: 'Verifier',
    visualDescription: 'Cream robot holding a magnifying glass',
    defaultAlt: 'Verifier robot inspecting clues with a magnifying glass',
  },
  reviewer: {
    title: 'Reviewer',
    visualDescription: 'Cream robot reading a document dossier',
    defaultAlt: 'Reviewer robot reading a document',
  },
  delivery: {
    title: 'Delivery Agent',
    visualDescription: 'Cream robot carrying a slate-blue briefcase',
    defaultAlt: 'Delivery robot holding a briefcase',
  },
  unknown: {
    title: 'Specialist Agent',
    visualDescription: 'Neutral autonomous agent',
    defaultAlt: 'Autonomous specialist agent',
  },
};

/**
 * Normalizes and maps actual application roles, base roles, and aliases to
 * the approved Dupond character archetypes.
 *
 * Inspects explicit role identifiers and aliases rather than guessing from
 * agent names or provider names.
 */
export function resolveCharacterRole(
  role?: string | null,
  baseRole?: string | null,
  agentId?: string | null,
): CharacterRole {
  const candidates = [role, baseRole, agentId].filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );

  for (const candidate of candidates) {
    const matched = matchRolePattern(candidate);
    if (matched !== 'unknown') {
      return matched;
    }
  }

  return 'unknown';
}

function matchRolePattern(raw: string): CharacterRole {
  const normalized = raw
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 1. Coordinator: Dupond with bowler hat & moustache
  // Application roles: Chief Orchestrator, System Orchestrator, Orchestrator, Coordinator, Scrum Master, Product & Scrum Scribe, agent-orch
  if (
    normalized === 'agent orch' ||
    normalized.includes('orchestrat') ||
    normalized.includes('coordinator') ||
    normalized.includes('scrum master') ||
    normalized.includes('scrum scribe') ||
    normalized.includes('product scribe') ||
    normalized.includes('project governance') ||
    normalized.includes('dupond prime')
  ) {
    return 'coordinator';
  }

  // 2. Planner: Robot with parchment map
  // Application roles: Solutions Architect, Solutions Architect & Tech Lead, Data Governance Lead, System Architect, Requirements, Spec Lead, agent-arch
  if (
    normalized === 'agent arch' ||
    normalized.includes('planner') ||
    (normalized.includes('architect') && !normalized.includes('release')) ||
    normalized.includes('data governance') ||
    normalized.includes('tech lead') ||
    normalized.includes('specification') ||
    normalized.includes('decomposition')
  ) {
    return 'planner';
  }

  // 3. Verifier: Robot with magnifying glass
  // Application roles: SecOps & Quality Assurance Lead, QA & Security Analyst, Penetration Tester, Authoritative Verifier, QA, Security, Verification, agent-qa
  if (
    normalized === 'agent qa' ||
    normalized.includes('verifier') ||
    normalized.includes('verification') ||
    normalized.includes('secops') ||
    normalized.includes('quality assurance') ||
    normalized.includes('penetration tester') ||
    normalized.includes('qa ') ||
    normalized.endsWith(' qa') ||
    normalized === 'qa' ||
    normalized.includes('security analyst') ||
    normalized.includes('security auditor') ||
    normalized.includes('e2e test') ||
    normalized.includes('test engineer')
  ) {
    return 'verifier';
  }

  // 4. Reviewer: Robot reading document dossier
  // Application roles: Reviewer, Code Reviewer, Diff Auditor, Inspection Lead, Document Reviewer
  if (
    normalized.includes('reviewer') ||
    normalized.includes('code review') ||
    normalized.includes('diff audit') ||
    normalized.includes('document review') ||
    normalized.includes('inspection lead') ||
    normalized.includes('audit & inspection')
  ) {
    return 'reviewer';
  }

  // 5. Delivery Agent: Robot with slate-blue briefcase
  // Application roles: DevOps & Site Reliability Engineer, DevOps Engineer, Release Architect, Release Specialist, Deployment, SRE, Delivery, agent-devops
  if (
    normalized === 'agent devops' ||
    normalized.includes('delivery') ||
    normalized.includes('devops') ||
    normalized.includes('site reliability') ||
    normalized.includes('release architect') ||
    normalized.includes('release specialist') ||
    normalized.includes('deployment engineer') ||
    normalized.includes('ci cd') ||
    normalized.includes('sre') ||
    normalized.includes('dispatch')
  ) {
    return 'delivery';
  }

  // 6. Coding Worker: Robot behind laptop
  // Application roles: Senior Frontend & UX Specialist, Frontend Engineer, Design Systems Lead, Backend & Integrations Engineer, Backend Engineer, Integration Specialist, Full-Stack Engineer, Lead Software Engineer, Developer, Coding Worker, Worker, agent-fe, agent-be
  if (
    normalized === 'agent fe' ||
    normalized === 'agent be' ||
    normalized.includes('coding worker') ||
    normalized.includes('code author') ||
    normalized.includes('worker') ||
    normalized.includes('frontend') ||
    normalized.includes('backend') ||
    normalized.includes('software engineer') ||
    normalized.includes('full stack') ||
    normalized.includes('developer') ||
    normalized.includes('design systems') ||
    normalized.includes('integration specialist') ||
    normalized.includes('integrations engineer') ||
    normalized.includes('ux specialist')
  ) {
    return 'coding-worker';
  }

  return 'unknown';
}

export function getAgentAvatarUrl(
  role?: string | null,
  baseRole?: string | null,
  agentId?: string | null,
): string | null {
  const character = resolveCharacterRole(role, baseRole, agentId);
  if (character === 'unknown') {
    return null;
  }
  return CHARACTER_AVATAR_ASSETS[character] || null;
}

export function getCharacterRoleInfo(character: CharacterRole): CharacterRoleInfo {
  const details = CHARACTER_ROLE_DETAILS[character];
  const assetUrl = character === 'unknown' ? null : CHARACTER_AVATAR_ASSETS[character] || null;

  return {
    character,
    ...details,
    assetUrl,
  };
}
