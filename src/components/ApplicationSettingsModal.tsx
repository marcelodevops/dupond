import React, { useState, useEffect, useRef, useCallback } from 'react';
import { projectApi } from '../lib/projectApi';
import {
  PlanningReadiness,
  GeminiCredentialStatus,
  OpenAICredentialStatus,
  AgyAuthStatus,
  CredentialSource,
  CredentialTestOutcome,
} from '../types/projectContract';
import {
  X,
  KeyRound,
  AlertTriangle,
  CheckCircle2,
  RotateCw,
  Cpu,
  Info,
  Save,
  Trash2,
  Globe,
} from 'lucide-react';

interface ApplicationSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGeminiCredentialChanged?: () => void;
  onOpenAICredentialChanged?: () => void;
}

interface ProviderCardStatus {
  source: CredentialSource;
  configured: boolean;
  hasSavedKey: boolean;
  environmentControlled: boolean;
  lastTestedAt: string | null;
  lastTestOutcome: CredentialTestOutcome | null;
  lastTestError: string | null;
  lastTestModel?: string | null;
}

interface ProviderTestOutcome {
  ok: boolean;
  stale?: boolean;
  inconclusive?: boolean;
  cancelled?: boolean;
  outcome?: 'passed' | 'failed' | 'inconclusive' | 'cancelled' | 'stale';
  source: CredentialSource;
  model: string;
  error?: string;
}

interface ProviderCredentialCardProps {
  provider: 'gemini' | 'openai';
  title: string;
  envVarName: string;
  placeholder: string;
  scopeDescription: string;
  paidNotice: string;
  status: ProviderCardStatus | null;
  isLoading: boolean;
  loadError: string | null;
  keyInput: string;
  onKeyInputChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  isOpen: boolean;
  globalBusy: boolean;
  onBusyChange: (provider: 'gemini' | 'openai', busy: boolean) => void;
  onSaveKey: (apiKey: string) => Promise<void>;
  onDeleteKey: () => Promise<void>;
  onTestConnection: (model: string | undefined, signal: AbortSignal) => Promise<ProviderTestOutcome>;
  onRefreshAfterCancel: () => Promise<void>;
  models?: string[];
  selectedModel?: string;
  onSelectModel?: (model: string) => void;
}

const ProviderCredentialCard: React.FC<ProviderCredentialCardProps> = ({
  provider,
  title,
  envVarName,
  placeholder,
  scopeDescription,
  paidNotice,
  status,
  isLoading,
  loadError,
  keyInput,
  onKeyInputChange,
  inputRef,
  isOpen,
  globalBusy,
  onBusyChange,
  onSaveKey,
  onDeleteKey,
  onTestConnection,
  onRefreshAfterCancel,
  models,
  selectedModel,
  onSelectModel,
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testElapsedSeconds, setTestElapsedSeconds] = useState(0);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [inconclusiveBanner, setInconclusiveBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const testAbortControllerRef = useRef<AbortController | null>(null);
  const testTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const testRunIdRef = useRef(0);
  const mountedRef = useRef(true);
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  const isCustomModelPreset = Boolean(
    models && models.length > 0 && selectedModel !== undefined && !models.includes(selectedModel),
  );
  const [customMode, setCustomMode] = useState(isCustomModelPreset);
  useEffect(() => {
    if (isCustomModelPreset) setCustomMode(true);
  }, [isCustomModelPreset]);

  const hasModelSelector = Boolean(models && models.length > 0 && onSelectModel);
  const effectiveSelectedModel = hasModelSelector ? (selectedModel || models![0]) : undefined;
  const testedModelMatchesSelected =
    !hasModelSelector || !status?.lastTestModel || status.lastTestModel === effectiveSelectedModel;
  const displayedTestOutcome = testedModelMatchesSelected ? status?.lastTestOutcome ?? null : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (testTimerRef.current) {
        clearInterval(testTimerRef.current);
        testTimerRef.current = null;
      }
      testAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setErrorBanner(null);
    setInconclusiveBanner(null);
    setSuccessBanner(null);
    setTestElapsedSeconds(0);
  }, [isOpen]);

  useEffect(() => {
    if (loadError && !status) {
      setErrorBanner(loadError);
    }
  }, [loadError, status]);

  useEffect(() => {
    onBusyChange(provider, isSaving || isDeleting || isTesting);
  }, [provider, isSaving, isDeleting, isTesting, onBusyChange]);

  const inputId = `${provider}-api-key-input`;
  const modelSelectId = `${provider}-test-model-select`;
  const label = provider === 'gemini' ? 'Gemini' : 'OpenAI';

  return (
    <div
      className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3"
      data-testid={`${provider}-credential-section`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-indigo-400" />
          <span className="font-semibold text-white">{title}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {isLoading || (!status && !loadError) ? (
            <span
              data-testid={`${provider}-saved-badge`}
              className="px-2 py-0.5 rounded text-[10px] font-bold border bg-slate-800/80 text-slate-300 border-slate-700 inline-flex items-center gap-1"
            >
              <RotateCw className="w-3 h-3 animate-spin text-slate-400" />
              <span>Loading...</span>
            </span>
          ) : loadError && !status ? (
            <span
              data-testid={`${provider}-saved-badge`}
              className="px-2 py-0.5 rounded text-[10px] font-bold border bg-rose-500/20 text-rose-300 border-rose-500/30"
            >
              Status Unavailable
            </span>
          ) : (
            <>
              <span
                data-testid={`${provider}-saved-badge`}
                className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                  status?.configured
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                    : 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                }`}
              >
                {status?.source === 'environment'
                  ? 'Env Active'
                  : status?.source === 'saved'
                    ? 'Saved'
                    : 'Not Configured'}
              </span>
              {status?.configured && (
                <span
                  data-testid={`${provider}-verified-badge`}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                    displayedTestOutcome === 'passed'
                      ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
                      : displayedTestOutcome === 'failed'
                        ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                        : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                  }`}
                >
                  {displayedTestOutcome === 'passed'
                    ? hasModelSelector && status.lastTestModel
                      ? `Verified (${status.lastTestModel})`
                      : 'Verified'
                    : displayedTestOutcome === 'failed'
                      ? hasModelSelector && status.lastTestModel
                        ? `Verification Failed (${status.lastTestModel})`
                        : 'Verification Failed'
                      : 'Unverified'}
                </span>
              )}
            </>
          )}
        </div>
      </div>

      <p
        className="text-[11px] text-slate-400"
        data-testid={provider === 'openai' ? 'openai-worker-scope-notice' : undefined}
      >
        {scopeDescription}
      </p>

      {status?.environmentControlled && (
        <div
          data-testid={`${provider}-env-precedence-notice`}
          className="p-2.5 rounded-lg bg-indigo-950/40 border border-indigo-800/60 text-indigo-200 text-[11px] flex items-start gap-2"
        >
          <Info className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
          <span>
            Server environment variable <code>{envVarName}</code> currently controls the active credential and takes precedence over any saved key. Saving or removing a key below cannot overwrite or unset the server environment variable.
          </span>
        </div>
      )}

      {errorBanner && (
        <div
          data-testid={`${provider}-error-banner`}
          className="p-2.5 rounded-lg bg-rose-950/50 border border-rose-800/70 text-rose-200 text-[11px] flex items-start gap-2"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
          <span>{errorBanner}</span>
        </div>
      )}

      {inconclusiveBanner && (
        <div
          data-testid={`${provider}-inconclusive-banner`}
          className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-700/60 text-amber-200 text-[11px] flex items-start gap-2"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
          <span>{inconclusiveBanner}</span>
        </div>
      )}

      {successBanner && (
        <div
          data-testid={`${provider}-success-banner`}
          className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-800/60 text-emerald-200 text-[11px] flex items-start gap-2"
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
          <span>{successBanner}</span>
        </div>
      )}

      {isTesting && (
        <div
          data-testid={`${provider}-test-pending`}
          className="p-2.5 rounded-lg bg-cyan-950/30 border border-cyan-800/60 text-cyan-100 text-[11px] space-y-1"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <RotateCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
              <span>Testing {label} connection...</span>
            </span>
            <span data-testid={`${provider}-test-elapsed`} className="font-mono text-cyan-300">
              Elapsed: {testElapsedSeconds}s
            </span>
          </div>
          <p className="text-[10px] text-slate-400">
            Cancelling aborts the local request, but cannot guarantee the provider incurs no usage.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <label className="block text-[11px] font-medium text-slate-300" htmlFor={inputId}>
          {status?.hasSavedKey ? `Replace Saved ${label} API Key` : `Enter ${label} API Key`}
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            ref={inputRef}
            id={inputId}
            data-testid={inputId}
            type="password"
            autoComplete="off"
            value={keyInput}
            onChange={(e) => onKeyInputChange(e.target.value)}
            placeholder={placeholder}
            disabled={globalBusy}
            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-60"
          />
          <button
            type="button"
            data-testid={`save-${provider}-key-btn`}
            disabled={globalBusy}
            onClick={async () => {
              setErrorBanner(null);
              setInconclusiveBanner(null);
              setSuccessBanner(null);
              if (!keyInput.trim()) {
                setErrorBanner(`${label} API key cannot be blank.`);
                return;
              }
              setIsSaving(true);
              try {
                await onSaveKey(keyInput);
                setSuccessBanner(
                  status?.environmentControlled
                    ? `Saved application key encrypted on server (server ${envVarName} still takes precedence).`
                    : `${label} API key saved securely on server and active immediately. Click Test Connection to verify it.`,
                );
              } catch (err: any) {
                setErrorBanner(err?.message || `Failed to save ${label} API key.`);
              } finally {
                setIsSaving(false);
              }
            }}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {isSaving ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            <span>{status?.hasSavedKey ? 'Replace Key' : 'Save Key'}</span>
          </button>
        </div>
      </div>

      {hasModelSelector && (
        <div className="space-y-1.5 pt-1">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <label htmlFor={modelSelectId} className="text-[11px] text-slate-400 shrink-0">
              Test Model:
            </label>
            <select
              id={modelSelectId}
              data-testid={modelSelectId}
              value={customMode ? '__custom__' : effectiveSelectedModel}
              onChange={(e) => {
                const val = e.target.value;
                if (val === '__custom__') {
                  setCustomMode(true);
                  if (models!.includes(effectiveSelectedModel || '')) {
                    onSelectModel!('');
                  }
                } else {
                  setCustomMode(false);
                  onSelectModel!(val);
                }
              }}
              disabled={isSaving || isDeleting}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-60"
            >
              {models!.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="__custom__">Custom model...</option>
            </select>
            {customMode && (
              <input
                type="text"
                data-testid={`${provider}-custom-model-input`}
                value={selectedModel ?? ''}
                onChange={(e) => onSelectModel!(e.target.value)}
                placeholder="e.g. gpt-4.1-mini"
                disabled={isSaving || isDeleting}
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-white font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-60"
              />
            )}
          </div>
          {status?.lastTestOutcome && status?.lastTestModel && !testedModelMatchesSelected && (
            <p
              data-testid={`${provider}-different-model-verified-note`}
              className="text-[10px] text-amber-300/90"
            >
              Last {status.lastTestOutcome} verification was for <code>{status.lastTestModel}</code>;{' '}
              <code>{effectiveSelectedModel || 'current model'}</code> is unverified.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid={`test-${provider}-key-btn`}
            disabled={!status?.configured || globalBusy}
            onClick={async () => {
              const testedModelSnapshot = effectiveSelectedModel;
              if (hasModelSelector && (!testedModelSnapshot || !testedModelSnapshot.trim())) {
                setErrorBanner('Enter a valid OpenAI model identifier before testing.');
                return;
              }
              const runId = ++testRunIdRef.current;
              const controller = new AbortController();
              testAbortControllerRef.current = controller;
              const startedAt = Date.now();

              setErrorBanner(null);
              setInconclusiveBanner(null);
              setSuccessBanner(null);
              setTestElapsedSeconds(0);
              setIsTesting(true);

              if (testTimerRef.current) {
                clearInterval(testTimerRef.current);
              }
              testTimerRef.current = setInterval(() => {
                if (mountedRef.current && testRunIdRef.current === runId) {
                  setTestElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
                }
              }, 250);

              try {
                const res = await onTestConnection(testedModelSnapshot, controller.signal);
                if (!mountedRef.current || testRunIdRef.current !== runId) return;
                const modelChangedDuringTest =
                  hasModelSelector && selectedModelRef.current !== testedModelSnapshot;
                if (res.stale || res.outcome === 'stale') {
                  setErrorBanner(res.error || 'Connection test result was superseded by a newer credential change.');
                } else if (res.inconclusive || res.outcome === 'inconclusive' || res.outcome === 'cancelled') {
                  setInconclusiveBanner(
                    res.error ||
                      'Connection test was inconclusive. Previous verification history was preserved.',
                  );
                } else if (modelChangedDuringTest) {
                  setInconclusiveBanner(
                    `Completed test (${res.ok ? 'passed' : 'failed'}) for ${res.model}, while selected model changed to ${selectedModelRef.current || '(blank)'}.`,
                  );
                } else if (res.ok) {
                  setSuccessBanner(`Connection verified (${res.source} credential, model ${res.model}).`);
                } else {
                  setErrorBanner(res.error || 'Connection test failed.');
                }
              } catch (err: any) {
                if (!mountedRef.current || testRunIdRef.current !== runId) return;
                if (err?.name === 'AbortError' || controller.signal.aborted) {
                  setInconclusiveBanner(
                    'Connection test was cancelled. Previous verification history was preserved, and cancelling cannot guarantee the provider incurred no usage.',
                  );
                  await onRefreshAfterCancel();
                } else {
                  setErrorBanner(err?.message || 'Connection test failed.');
                }
              } finally {
                if (testTimerRef.current) {
                  clearInterval(testTimerRef.current);
                  testTimerRef.current = null;
                }
                if (testAbortControllerRef.current === controller) {
                  testAbortControllerRef.current = null;
                }
                if (mountedRef.current && testRunIdRef.current === runId) {
                  setIsTesting(false);
                }
              }
            }}
            className="px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950/40 hover:bg-cyan-900/50 text-cyan-200 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40"
          >
            {isTesting ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            <span>{isTesting ? 'Testing...' : 'Test Connection'}</span>
          </button>

          {isTesting && (
            <button
              type="button"
              data-testid={`cancel-${provider}-test-btn`}
              onClick={() => {
                testAbortControllerRef.current?.abort();
              }}
              className="px-3 py-1.5 rounded-lg border border-amber-500/50 bg-amber-950/40 hover:bg-amber-900/50 text-amber-200 text-xs font-semibold flex items-center gap-1.5"
            >
              <X className="w-3.5 h-3.5" />
              <span>Cancel</span>
            </button>
          )}

          {status?.hasSavedKey && (
            <button
              type="button"
              data-testid={`delete-${provider}-key-btn`}
              disabled={globalBusy}
              onClick={async () => {
                setErrorBanner(null);
                setInconclusiveBanner(null);
                setSuccessBanner(null);
                setIsDeleting(true);
                try {
                  await onDeleteKey();
                  setSuccessBanner(`Saved ${label} API key removed immediately.`);
                } catch (err: any) {
                  setErrorBanner(err?.message || `Failed to remove saved ${label} API key.`);
                } finally {
                  setIsDeleting(false);
                }
              }}
              className="px-3 py-1.5 rounded-lg border border-rose-500/40 bg-rose-950/30 hover:bg-rose-900/40 text-rose-300 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40"
            >
              {isDeleting ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              <span>Remove Saved Key</span>
            </button>
          )}
        </div>
        <span className="text-[10px] text-slate-500">{paidNotice}</span>
      </div>

      {(status?.lastTestedAt || status?.lastTestError) && (
        <div className="text-[11px] text-slate-400 pt-2 border-t border-slate-800/80 space-y-1">
          {status.lastTestedAt && (
            <div className="flex justify-between gap-2">
              <span>Last Tested{status.lastTestModel ? ` (${status.lastTestModel})` : ''}:</span>
              <span className="font-mono text-slate-300">{new Date(status.lastTestedAt).toLocaleString()}</span>
            </div>
          )}
          {status.lastTestError && (
            <p className="text-rose-300 text-[11px]" data-testid={`${provider}-last-test-error`}>
              Last Test Error: {status.lastTestError}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export const ApplicationSettingsModal: React.FC<ApplicationSettingsModalProps> = ({
  isOpen,
  onClose,
  onGeminiCredentialChanged,
  onOpenAICredentialChanged,
}) => {
  const [planningReadiness, setPlanningReadiness] = useState<PlanningReadiness | null>(null);
  const [geminiStatus, setGeminiStatus] = useState<GeminiCredentialStatus | null>(null);
  const [openaiStatus, setOpenaiStatus] = useState<OpenAICredentialStatus | null>(null);
  const [isLoadingGemini, setIsLoadingGemini] = useState(false);
  const [isLoadingOpenAI, setIsLoadingOpenAI] = useState(false);
  const [geminiLoadError, setGeminiLoadError] = useState<string | null>(null);
  const [openaiLoadError, setOpenaiLoadError] = useState<string | null>(null);
  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [openaiKeyInput, setOpenaiKeyInput] = useState('');
  const [selectedOpenAIModel, setSelectedOpenAIModel] = useState('gpt-4o-mini');
  const [busyByProvider, setBusyByProvider] = useState<{ gemini: boolean; openai: boolean }>({
    gemini: false,
    openai: false,
  });
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [agyAuthStatus, setAgyAuthStatus] = useState<AgyAuthStatus | null>(null);
  const [agyCodeInput, setAgyCodeInput] = useState('');
  const [agyBusy, setAgyBusy] = useState(false);
  const [agyError, setAgyError] = useState<string | null>(null);
  const [agyNotice, setAgyNotice] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isDirty = geminiKeyInput.trim().length > 0 || openaiKeyInput.trim().length > 0;
  const isBusy = busyByProvider.gemini || busyByProvider.openai;

  const handleBusyChange = useCallback((provider: 'gemini' | 'openai', busy: boolean) => {
    setBusyByProvider((prev) => (prev[provider] === busy ? prev : { ...prev, [provider]: busy }));
  }, []);

  const handleRequestClose = useCallback(() => {
    if (isBusy) return;
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    setShowDiscardConfirm(false);
    onClose();
  }, [isBusy, isDirty, onClose]);

  const handleConfirmDiscard = () => {
    setGeminiKeyInput('');
    setOpenaiKeyInput('');
    setShowDiscardConfirm(false);
    onClose();
  };

  const handleRequestCloseRef = useRef(handleRequestClose);
  handleRequestCloseRef.current = handleRequestClose;

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => {
      clearTimeout(focusTimer);
      previousFocusRef.current?.focus?.();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleRequestCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setPlanningReadiness(null);
      setGeminiStatus(null);
      setOpenaiStatus(null);
      setAgyAuthStatus(null);
      setAgyCodeInput('');
      setAgyError(null);
      setAgyNotice(null);
      setGeminiLoadError(null);
      setOpenaiLoadError(null);
      setShowDiscardConfirm(false);
      return;
    }
    setGeminiKeyInput('');
    setOpenaiKeyInput('');
    setAgyCodeInput('');
    setAgyError(null);
    setAgyNotice(null);
    setShowDiscardConfirm(false);

    let mounted = true;
    setIsLoadingGemini(true);
    setIsLoadingOpenAI(true);
    setGeminiLoadError(null);
    setOpenaiLoadError(null);
    setPlanningReadiness(null);
    setGeminiStatus(null);
    setOpenaiStatus(null);

    projectApi
      .getAgyAuthStatus()
      .then((agyRes) => {
        if (mounted) setAgyAuthStatus(agyRes);
      })
      .catch((err) => {
        if (mounted) setAgyError(err?.message || 'Failed to load Antigravity CLI auth status.');
      });

    Promise.all([projectApi.getPlanningReadiness(), projectApi.getGeminiCredentialStatus()])
      .then(([readinessRes, credRes]) => {
        if (mounted) {
          setPlanningReadiness(readinessRes);
          setGeminiStatus(credRes);
          setGeminiLoadError(null);
        }
      })
      .catch((err) => {
        if (mounted) {
          setGeminiLoadError(err?.message || 'Failed to load Gemini credential status.');
        }
      })
      .finally(() => {
        if (mounted) setIsLoadingGemini(false);
      });

    projectApi
      .getOpenAICredentialStatus()
      .then((credRes) => {
        if (mounted) {
          setOpenaiStatus(credRes);
          if (credRes.model) setSelectedOpenAIModel(credRes.model);
          setOpenaiLoadError(null);
        }
      })
      .catch((err) => {
        if (mounted) {
          setOpenaiLoadError(err?.message || 'Failed to load OpenAI credential status.');
        }
      })
      .finally(() => {
        if (mounted) setIsLoadingOpenAI(false);
      });

    return () => {
      mounted = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleRequestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        data-testid="application-settings-modal"
        className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full shadow-2xl overflow-hidden my-auto flex flex-col max-h-[92vh]"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-4 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-start space-x-2.5 min-w-0">
            <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 shrink-0">
              <Globe className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 id="app-settings-title" className="text-base font-bold text-white flex items-center gap-2 flex-wrap">
                <span>Application Settings</span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                  Server-Wide
                </span>
              </h2>
              <p data-testid="app-settings-scope-notice" className="text-xs text-slate-400 mt-0.5">
                Shared configuration for this Dupond server instance. Changes here affect every project on this server.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRequestClose}
            aria-label="Close Application Settings"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0 focus:outline-none focus:ring-2 focus:ring-cyan-500"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-5 text-xs text-slate-300">
          {showDiscardConfirm && (
            <div
              data-testid="app-settings-discard-confirm"
              className="p-3.5 rounded-xl bg-amber-950/50 border border-amber-700/70 text-amber-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>You have entered an unsaved API key. Discard it and close?</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  data-testid="app-settings-keep-editing-btn"
                  onClick={() => setShowDiscardConfirm(false)}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold"
                >
                  Keep Editing
                </button>
                <button
                  type="button"
                  data-testid="app-settings-confirm-discard-btn"
                  onClick={handleConfirmDiscard}
                  className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-semibold"
                >
                  Discard &amp; Close
                </button>
              </div>
            </div>
          )}

          {/* Gemini Credential Management Card */}
          <ProviderCredentialCard
            provider="gemini"
            title="Gemini API Credential"
            envVarName="GEMINI_API_KEY"
            placeholder="AIza..."
            scopeDescription="Saved Gemini credentials are application-scoped and apply to every project on this server instance. Keys are encrypted on the server, never returned to the browser, and credential actions take effect immediately."
            paidNotice="Test sends a minimal Gemini request (may incur API usage)."
            status={geminiStatus}
            isLoading={isLoadingGemini}
            loadError={geminiLoadError}
            keyInput={geminiKeyInput}
            onKeyInputChange={setGeminiKeyInput}
            inputRef={inputRef}
            isOpen={isOpen}
            globalBusy={isBusy}
            onBusyChange={handleBusyChange}
            onSaveKey={async (apiKey) => {
              const updated = await projectApi.saveGeminiCredential(apiKey);
              setGeminiStatus(updated);
              setGeminiKeyInput('');
              setShowDiscardConfirm(false);
              const refreshed = await projectApi.getPlanningReadiness();
              setPlanningReadiness(refreshed);
              onGeminiCredentialChanged?.();
            }}
            onDeleteKey={async () => {
              const updated = await projectApi.deleteGeminiCredential();
              setGeminiStatus(updated);
              setGeminiKeyInput('');
              setShowDiscardConfirm(false);
              const refreshed = await projectApi.getPlanningReadiness();
              setPlanningReadiness(refreshed);
              onGeminiCredentialChanged?.();
            }}
            onTestConnection={async (_model, signal) => {
              const res = await projectApi.testGeminiCredential(signal);
              setGeminiStatus(res.status);
              const refreshed = await projectApi.getPlanningReadiness();
              setPlanningReadiness(refreshed);
              onGeminiCredentialChanged?.();
              return res;
            }}
            onRefreshAfterCancel={async () => {
              try {
                const [credRes, readinessRes] = await Promise.all([
                  projectApi.getGeminiCredentialStatus(),
                  projectApi.getPlanningReadiness(),
                ]);
                setGeminiStatus(credRes);
                setPlanningReadiness(readinessRes);
              } catch {
                // Preserve current status if background refresh fails after cancel
              }
              onGeminiCredentialChanged?.();
            }}
          />

          {/* OpenAI Credential Management Card (Coding Workers) */}
          <ProviderCredentialCard
            provider="openai"
            title="OpenAI API Credential (Coding Workers)"
            envVarName="OPENAI_API_KEY"
            placeholder="sk-..."
            scopeDescription="Saved OpenAI credentials are application-scoped and configure OpenAI coding workers across every project on this server instance (AI planning still uses Gemini). Keys are encrypted on the server, never returned to the browser, and credential actions take effect immediately."
            paidNotice="Test sends a minimal OpenAI Responses API request (may incur API usage)."
            status={openaiStatus}
            isLoading={isLoadingOpenAI}
            loadError={openaiLoadError}
            keyInput={openaiKeyInput}
            onKeyInputChange={setOpenaiKeyInput}
            isOpen={isOpen}
            globalBusy={isBusy}
            onBusyChange={handleBusyChange}
            models={openaiStatus?.supportedModels || ['gpt-4o-mini', 'gpt-4o', 'o3-mini', 'o1', 'gpt-4.5-preview']}
            selectedModel={selectedOpenAIModel}
            onSelectModel={setSelectedOpenAIModel}
            onSaveKey={async (apiKey) => {
              const updated = await projectApi.saveOpenAICredential(apiKey);
              setOpenaiStatus(updated);
              setOpenaiKeyInput('');
              setShowDiscardConfirm(false);
              onOpenAICredentialChanged?.();
            }}
            onDeleteKey={async () => {
              const updated = await projectApi.deleteOpenAICredential();
              setOpenaiStatus(updated);
              setOpenaiKeyInput('');
              setShowDiscardConfirm(false);
              onOpenAICredentialChanged?.();
            }}
            onTestConnection={async (model, signal) => {
              const res = await projectApi.testOpenAICredential(model, signal);
              setOpenaiStatus(res.status);
              onOpenAICredentialChanged?.();
              return res;
            }}
            onRefreshAfterCancel={async () => {
              try {
                const credRes = await projectApi.getOpenAICredentialStatus();
                setOpenaiStatus(credRes);
              } catch {
                // Preserve current status if background refresh fails after cancel
              }
              onOpenAICredentialChanged?.();
            }}
          />

          {/* Effective Runtime AI Planning Readiness */}
          <div className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2" data-testid="app-planning-readiness-card">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-indigo-400" />
                <span className="font-semibold text-white">Effective AI Planning Runtime</span>
              </div>
              {isLoadingGemini || (!planningReadiness && !geminiLoadError) ? (
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700 inline-flex items-center gap-1">
                  <RotateCw className="w-3 h-3 animate-spin text-slate-400" />
                  <span>Checking...</span>
                </span>
              ) : geminiLoadError && !planningReadiness ? (
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
                  Error
                </span>
              ) : planningReadiness?.ready ? (
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  Ready
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
                  Unconfigured
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-400 space-y-1">
              <div className="flex justify-between">
                <span>Runtime Provider:</span>
                <span className="font-mono text-slate-200">{planningReadiness?.provider || 'gemini'}</span>
              </div>
              <div className="flex justify-between">
                <span>Runtime Model (env / default):</span>
                <span className="font-mono text-slate-200">{planningReadiness?.model || 'gemini-3.8-flash'}</span>
              </div>
              <div className="flex justify-between">
                <span>Active Credential Source:</span>
                <span className="font-mono text-slate-200">{planningReadiness?.source || 'none'}</span>
              </div>
              {planningReadiness?.error && (
                <p className="text-rose-300 text-[10px] mt-1 pt-1 border-t border-rose-900/40">
                  {planningReadiness.error}
                </p>
              )}
            </div>
          </div>

          {/* Antigravity CLI (Dedicated Profile PTY OAuth Prototype) */}
          <div
            data-testid="agy-auth-card"
            className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2.5"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-slate-200">
                  Antigravity CLI (Dedicated Profile)
                </div>
                <div className="text-[11px] text-slate-400">
                  Isolated OAuth onboarding via PTY into Dupond&apos;s dedicated profile directory.
                </div>
              </div>
              {agyAuthStatus?.profileAuthenticated ? (
                <span
                  data-testid="agy-auth-badge"
                  className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                >
                  Authenticated ({agyAuthStatus.availableModelsCount} models)
                </span>
              ) : (
                <span
                  data-testid="agy-auth-badge"
                  className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30"
                >
                  Not Signed In
                </span>
              )}
            </div>

            {agyAuthStatus && (
              <div
                data-testid="agy-auth-verification-states"
                className="grid grid-cols-2 gap-1.5 text-[10px] text-slate-300 bg-slate-900/70 border border-slate-800/80 rounded-lg p-2"
              >
                <div>Credentials present: {agyAuthStatus.credentialsPresent ? 'Yes' : 'No'}</div>
                <div>Profile auth verified: {agyAuthStatus.profileAuthVerified ? 'Yes' : 'No'}</div>
                <div>Sandbox auth verified: {agyAuthStatus.sandboxAuthVerified ? 'Yes' : 'Unverified'}</div>
                <div>Coding execution verified: {agyAuthStatus.executionVerified ? 'Yes' : 'Unverified'}</div>
              </div>
            )}

            {agyAuthStatus?.onboardingSupported === false && agyAuthStatus.onboardingUnavailableReason && (
              <div
                data-testid="agy-auth-unavailable-reason"
                className="p-2 rounded-lg bg-amber-950/40 border border-amber-800/60 text-amber-200 text-[11px]"
              >
                {agyAuthStatus.onboardingUnavailableReason}
              </div>
            )}

            {agyError && (
              <div
                data-testid="agy-auth-error"
                className="p-2 rounded-lg bg-rose-950/40 border border-rose-800/60 text-rose-200 text-[11px]"
              >
                {agyError}
              </div>
            )}

            {agyNotice && (
              <div
                data-testid="agy-auth-notice"
                className="p-2 rounded-lg bg-emerald-950/40 border border-emerald-800/60 text-emerald-200 text-[11px]"
              >
                {agyNotice}
              </div>
            )}

            {agyAuthStatus?.session?.state === 'awaiting_code' && agyAuthStatus.session.authUrl ? (
              <div className="space-y-2 pt-1">
                <div className="text-[11px] text-slate-300">
                  1. Open the official Antigravity Google login link and sign in:
                </div>
                <a
                  data-testid="agy-auth-url"
                  href={agyAuthStatus.session.authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block p-2 rounded-lg bg-slate-900 border border-slate-700 text-indigo-300 hover:text-indigo-200 text-[11px] font-mono break-all underline"
                >
                  {agyAuthStatus.session.authUrl}
                </a>
                <div className="text-[11px] text-slate-300">
                  2. Paste the authorization code from the completion page:
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    type="password"
                    data-testid="agy-auth-code-input"
                    autoComplete="off"
                    value={agyCodeInput}
                    onChange={(e) => setAgyCodeInput(e.target.value)}
                    placeholder="Paste authorization code..."
                    disabled={agyBusy}
                    className="flex-1 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    type="button"
                    data-testid="agy-auth-submit-btn"
                    disabled={agyBusy || !agyCodeInput.trim()}
                    onClick={async () => {
                      const sessionId = agyAuthStatus.session?.loginSessionId;
                      if (!sessionId) return;
                      const submitted = agyCodeInput;
                      setAgyCodeInput('');
                      setAgyBusy(true);
                      setAgyError(null);
                      setAgyNotice(null);
                      try {
                        const res = await projectApi.submitAgyAuthCode(sessionId, submitted);
                        if (res.authenticated) {
                          setAgyNotice(`Dedicated profile authenticated (${res.modelsCount} models available).`);
                        } else {
                          setAgyError(res.error || 'Authentication failed.');
                        }
                        setAgyAuthStatus(await projectApi.getAgyAuthStatus());
                      } catch (err: any) {
                        setAgyError(err?.message || 'Failed to submit authorization code.');
                        try {
                          setAgyAuthStatus(await projectApi.getAgyAuthStatus());
                        } catch {}
                      } finally {
                        setAgyBusy(false);
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50"
                  >
                    {agyBusy ? 'Submitting...' : 'Submit Code'}
                  </button>
                  <button
                    type="button"
                    data-testid="agy-auth-cancel-btn"
                    disabled={agyBusy}
                    onClick={async () => {
                      setAgyCodeInput('');
                      setAgyBusy(true);
                      setAgyError(null);
                      try {
                        await projectApi.cancelAgyAuth(agyAuthStatus.session?.loginSessionId);
                        setAgyAuthStatus(await projectApi.getAgyAuthStatus());
                      } catch (err: any) {
                        setAgyError(err?.message || 'Failed to cancel login.');
                      } finally {
                        setAgyBusy(false);
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-semibold disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-slate-400">
                  {agyAuthStatus?.cliAvailable
                    ? `CLI v${agyAuthStatus.version || 'unknown'} ready`
                    : 'Antigravity CLI (agy) not found on server'}
                </span>
                <button
                  type="button"
                  data-testid="agy-auth-start-btn"
                  disabled={agyBusy || agyAuthStatus?.cliAvailable === false || agyAuthStatus?.onboardingSupported === false}
                  onClick={async () => {
                    setAgyCodeInput('');
                    setAgyBusy(true);
                    setAgyError(null);
                    setAgyNotice(null);
                    try {
                      await projectApi.startAgyAuth();
                      setAgyAuthStatus(await projectApi.getAgyAuthStatus());
                    } catch (err: any) {
                      setAgyError(err?.message || 'Failed to start Antigravity CLI login.');
                    } finally {
                      setAgyBusy(false);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50"
                >
                  {agyBusy
                    ? 'Starting...'
                    : agyAuthStatus?.onboardingSupported === false
                      ? 'Unavailable on macOS'
                      : agyAuthStatus?.profileAuthenticated
                        ? 'Reconnect Antigravity CLI'
                        : 'Connect Antigravity CLI'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 border-t border-slate-800 bg-slate-950/80">
          <span className="text-[11px] text-slate-500">
            {isDirty ? 'Unsaved key input in field' : 'Credential actions apply immediately'}
          </span>
          <button
            type="button"
            data-testid="close-app-settings-btn"
            onClick={handleRequestClose}
            disabled={isBusy}
            className="px-4 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 hover:text-white text-xs font-semibold transition-colors disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
