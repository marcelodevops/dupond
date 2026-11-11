import React from 'react';
import { Bot } from 'lucide-react';
import { Agent } from '../types';
import {
  CharacterRole,
  resolveCharacterRole,
  CHARACTER_AVATAR_ASSETS,
  CHARACTER_ROLE_DETAILS,
} from '../lib/agentAvatars';

export type AgentAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;

export interface AgentAvatarProps {
  /** Optional agent object to pull role, baseRole, id, name, and status from */
  agent?: Pick<Agent, 'id' | 'name' | 'role' | 'baseRole' | 'avatar' | 'status'> | null;
  /** Explicit role title or identifier override */
  role?: string | null;
  /** Explicit base role fallback */
  baseRole?: string | null;
  /** Explicit agent ID */
  agentId?: string | null;
  /** Agent display name (used for accessible labeling when not purely decorative) */
  name?: string | null;
  /** Visual display size: 'xs' (20px), 'sm' (32px), 'md' (48px), 'lg' (64px), 'xl' (96px), or custom px number */
  size?: AgentAvatarSize;
  /** Execution status override for rendering the status badge */
  status?: Agent['status'];
  /** Whether to render the status badge overlay (defaults to true if status is present) */
  showStatus?: boolean;
  /** Custom CSS classes for the outer container */
  className?: string;
  /** Custom CSS classes for the image inside */
  imageClassName?: string;
  /**
   * Accessible alt text. When omitted and adjacent text identifies the agent,
   * set `decorative: true` to avoid duplicate screen-reader announcements.
   */
  alt?: string;
  /** When true, marks image with empty alt and aria-hidden for screen-reader hygiene */
  decorative?: boolean;
}

const PRESET_SIZES: Record<
  'xs' | 'sm' | 'md' | 'lg' | 'xl',
  { containerClass: string; iconClass: string; statusClass: string; px: number }
> = {
  xs: { containerClass: 'w-5 h-5', iconClass: 'w-3 h-3', statusClass: 'w-1.5 h-1.5', px: 20 },
  sm: { containerClass: 'w-8 h-8', iconClass: 'w-4 h-4', statusClass: 'w-2 h-2', px: 32 },
  md: { containerClass: 'w-11 h-11', iconClass: 'w-5 h-5', statusClass: 'w-2.5 h-2.5', px: 44 },
  lg: { containerClass: 'w-14 h-14', iconClass: 'w-7 h-7', statusClass: 'w-3 h-3', px: 56 },
  xl: { containerClass: 'w-24 h-24', iconClass: 'w-10 h-10', statusClass: 'w-4 h-4', px: 96 },
};

const STATUS_COLOR_MAP: Record<Agent['status'], string> = {
  working: 'bg-emerald-400',
  reviewing: 'bg-amber-400',
  blocked: 'bg-rose-500',
  idle: 'bg-slate-400',
};

export const AgentAvatar: React.FC<AgentAvatarProps> = ({
  agent,
  role,
  baseRole,
  agentId,
  name,
  size = 'md',
  status,
  showStatus,
  className = '',
  imageClassName = '',
  alt,
  decorative = true,
}) => {
  // Resolve actual role and candidate inputs
  const resolvedRole = role ?? agent?.role ?? null;
  const resolvedBaseRole = baseRole ?? agent?.baseRole ?? null;
  const resolvedAgentId = agentId ?? agent?.id ?? null;
  const resolvedName = name ?? agent?.name ?? null;
  const resolvedStatus = status ?? agent?.status ?? undefined;

  const character: CharacterRole = resolveCharacterRole(
    resolvedRole,
    resolvedBaseRole,
    resolvedAgentId,
  );

  const characterDetails = CHARACTER_ROLE_DETAILS[character];
  const avatarUrl = character !== 'unknown' ? CHARACTER_AVATAR_ASSETS[character] : null;

  // Determine container dimensions and styles
  let sizeStyle: React.CSSProperties | undefined;
  let containerSizeClass = '';
  let iconSizeClass = 'w-4 h-4';
  let statusBadgeSizeClass = 'w-2.5 h-2.5';

  if (typeof size === 'number') {
    sizeStyle = { width: `${size}px`, height: `${size}px` };
    iconSizeClass = size < 28 ? 'w-3 h-3' : size < 48 ? 'w-4 h-4' : 'w-6 h-6';
    statusBadgeSizeClass = size < 28 ? 'w-1.5 h-1.5' : size < 48 ? 'w-2 h-2' : 'w-2.5 h-2.5';
  } else {
    const preset = PRESET_SIZES[size] || PRESET_SIZES.md;
    containerSizeClass = preset.containerClass;
    iconSizeClass = preset.iconClass;
    statusBadgeSizeClass = preset.statusClass;
  }

  // Accessibility formatting
  const computedAlt = decorative
    ? ''
    : alt ?? (resolvedName ? `${resolvedName} (${characterDetails.title})` : characterDetails.defaultAlt);

  const shouldRenderStatus = (showStatus ?? (resolvedStatus !== undefined)) && resolvedStatus !== undefined;

  return (
    <div
      className={`relative shrink-0 rounded-full bg-slate-800/90 border border-slate-700/60 flex items-center justify-center select-none shadow-sm ${containerSizeClass} ${className}`}
      style={sizeStyle}
      aria-hidden={decorative ? 'true' : undefined}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={computedAlt}
          className={`w-full h-full object-contain p-0.5 rounded-full pointer-events-none ${imageClassName}`}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center text-slate-400 bg-slate-800/80 rounded-full"
          title={characterDetails.title}
        >
          <Bot className={iconSizeClass} />
        </div>
      )}

      {shouldRenderStatus && (
        <span
          className={`absolute bottom-0 right-0 rounded-full border-2 border-slate-900 pointer-events-none ${
            STATUS_COLOR_MAP[resolvedStatus]
          } ${statusBadgeSizeClass}`}
          title={`Status: ${resolvedStatus}`}
          aria-label={`Status: ${resolvedStatus}`}
        />
      )}
    </div>
  );
};

export default AgentAvatar;
