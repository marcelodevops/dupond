import React, { useState, useEffect, useRef, useCallback } from 'react';
import { projectApi } from '../lib/projectApi';
import { PlanningReadiness, GeminiCredentialStatus } from '../types/projectContract';
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
}

export const ApplicationSettingsModal: React.FC<ApplicationSettingsModalProps> = ({
  isOpen,
  onClose,
  onGeminiCredentialChanged,
}) => {
  const [planningReadiness, setPlanningReadiness] = useState<PlanningReadiness | null>(null);
  const [geminiStatus, setGeminiStatus] = useState<GeminiCredentialStatus | null>(null);
  const [isLoadingReadiness, setIsLoadingReadiness] = useState(false);
  const [readinessLoadError, setReadinessLoadError] = useState<string | null>(null);
  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [isSavingGemini, setIsSavingGemini] = useState(false);
  const [isDeletingGemini, setIsDeletingGemini] = useState(false);
  const [isTestingGemini, setIsTestingGemini] = useState(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);
  const [geminiSuccess, setGeminiSuccess] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isDirty = geminiKeyInput.trim().length > 0;
  const isBusy = isSavingGemini || isDeletingGemini || isTestingGemini;

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
    setShowDiscardConfirm(false);
    onClose();
  };

  const handleRequestCloseRef = useRef(handleRequestClose);
  handleRequestCloseRef.current = handleRequestClose;

  // Initial focus & focus restoration (runs only on open/close transitions)
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

  // Escape key handler (uses ref so dirty/busy changes never steal focus)
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

  // Reset transient banners & load status on open
  useEffect(() => {
    if (!isOpen) {
      setPlanningReadiness(null);
      setGeminiStatus(null);
      setReadinessLoadError(null);
      setShowDiscardConfirm(false);
      return;
    }
    setGeminiKeyInput('');
    setGeminiError(null);
    setGeminiSuccess(null);
    setShowDiscardConfirm(false);

    let mounted = true;
    setIsLoadingReadiness(true);
    setReadinessLoadError(null);
    setPlanningReadiness(null);
    setGeminiStatus(null);

    Promise.all([
      projectApi.getPlanningReadiness(),
      projectApi.getGeminiCredentialStatus(),
    ])
      .then(([readinessRes, credRes]) => {
        if (mounted) {
          setPlanningReadiness(readinessRes);
          setGeminiStatus(credRes);
          setReadinessLoadError(null);
        }
      })
      .catch((err) => {
        if (mounted) {
          const msg = err?.message || 'Failed to load Gemini credential status.';
          setReadinessLoadError(msg);
          setGeminiError(msg);
        }
      })
      .finally(() => {
        if (mounted) setIsLoadingReadiness(false);
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
                <span>You have entered an unsaved Gemini API key. Discard it and close?</span>
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
          <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3" data-testid="gemini-credential-section">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-indigo-400" />
                <span className="font-semibold text-white">Gemini API Credential</span>
              </div>
              <div className="flex items-center gap-1.5">
                {isLoadingReadiness || (!geminiStatus && !readinessLoadError) ? (
                  <span
                    data-testid="gemini-saved-badge"
                    className="px-2 py-0.5 rounded text-[10px] font-bold border bg-slate-800/80 text-slate-300 border-slate-700 inline-flex items-center gap-1"
                  >
                    <RotateCw className="w-3 h-3 animate-spin text-slate-400" />
                    <span>Loading...</span>
                  </span>
                ) : readinessLoadError && !geminiStatus ? (
                  <span
                    data-testid="gemini-saved-badge"
                    className="px-2 py-0.5 rounded text-[10px] font-bold border bg-rose-500/20 text-rose-300 border-rose-500/30"
                  >
                    Status Unavailable
                  </span>
                ) : (
                  <>
                    <span
                      data-testid="gemini-saved-badge"
                      className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                        geminiStatus?.configured
                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                          : 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                      }`}
                    >
                      {geminiStatus?.source === 'environment'
                        ? 'Env Active'
                        : geminiStatus?.source === 'saved'
                          ? 'Saved'
                          : 'Not Configured'}
                    </span>
                    {geminiStatus?.configured && (
                      <span
                        data-testid="gemini-verified-badge"
                        className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                          geminiStatus.lastTestOutcome === 'passed'
                            ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
                            : geminiStatus.lastTestOutcome === 'failed'
                              ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                              : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                        }`}
                      >
                        {geminiStatus.lastTestOutcome === 'passed'
                          ? 'Verified'
                          : geminiStatus.lastTestOutcome === 'failed'
                            ? 'Verification Failed'
                            : 'Unverified'}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>

            <p className="text-[11px] text-slate-400">
              Saved Gemini credentials are <strong className="text-slate-200">application-scoped</strong> and apply to every project on this server instance. Keys are encrypted on the server, never returned to the browser, and credential actions take effect immediately.
            </p>

            {geminiStatus?.environmentControlled && (
              <div
                data-testid="gemini-env-precedence-notice"
                className="p-2.5 rounded-lg bg-indigo-950/40 border border-indigo-800/60 text-indigo-200 text-[11px] flex items-start gap-2"
              >
                <Info className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                <span>
                  Server environment variable <code>GEMINI_API_KEY</code> currently controls the active credential and takes precedence over any saved key. Saving or removing a key below cannot overwrite or unset the server environment variable.
                </span>
              </div>
            )}

            {geminiError && (
              <div
                data-testid="gemini-error-banner"
                className="p-2.5 rounded-lg bg-rose-950/50 border border-rose-800/70 text-rose-200 text-[11px] flex items-start gap-2"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                <span>{geminiError}</span>
              </div>
            )}

            {geminiSuccess && (
              <div
                data-testid="gemini-success-banner"
                className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-800/60 text-emerald-200 text-[11px] flex items-start gap-2"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span>{geminiSuccess}</span>
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-[11px] font-medium text-slate-300" htmlFor="gemini-api-key-input">
                {geminiStatus?.hasSavedKey ? 'Replace Saved Gemini API Key' : 'Enter Gemini API Key'}
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  ref={inputRef}
                  id="gemini-api-key-input"
                  data-testid="gemini-api-key-input"
                  type="password"
                  autoComplete="off"
                  value={geminiKeyInput}
                  onChange={(e) => setGeminiKeyInput(e.target.value)}
                  placeholder="AIza..."
                  disabled={isBusy}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                />
                <button
                  type="button"
                  data-testid="save-gemini-key-btn"
                  disabled={isBusy}
                  onClick={async () => {
                    setGeminiError(null);
                    setGeminiSuccess(null);
                    if (!geminiKeyInput.trim()) {
                      setGeminiError('Gemini API key cannot be blank.');
                      return;
                    }
                    setIsSavingGemini(true);
                    try {
                      const updated = await projectApi.saveGeminiCredential(geminiKeyInput);
                      setGeminiStatus(updated);
                      setGeminiKeyInput('');
                      setShowDiscardConfirm(false);
                      setGeminiSuccess(
                        updated.environmentControlled
                          ? 'Saved application key encrypted on server (server GEMINI_API_KEY still takes precedence).'
                          : 'Gemini API key saved securely on server and active immediately. Click Test Connection to verify it.',
                      );
                      const refreshed = await projectApi.getPlanningReadiness();
                      setPlanningReadiness(refreshed);
                      onGeminiCredentialChanged?.();
                    } catch (err: any) {
                      setGeminiError(err?.message || 'Failed to save Gemini API key.');
                    } finally {
                      setIsSavingGemini(false);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  {isSavingGemini ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span>{geminiStatus?.hasSavedKey ? 'Replace Key' : 'Save Key'}</span>
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="test-gemini-key-btn"
                  disabled={!geminiStatus?.configured || isBusy}
                  onClick={async () => {
                    setGeminiError(null);
                    setGeminiSuccess(null);
                    setIsTestingGemini(true);
                    try {
                      const res = await projectApi.testGeminiCredential();
                      setGeminiStatus(res.status);
                      const refreshed = await projectApi.getPlanningReadiness();
                      setPlanningReadiness(refreshed);
                      if (res.stale || res.outcome === 'stale') {
                        setGeminiError(res.error || 'Connection test result was superseded by a newer credential change.');
                      } else if (res.ok) {
                        setGeminiSuccess(`Connection verified (${res.source} credential, model ${res.model}).`);
                      } else {
                        setGeminiError(res.error || 'Connection test failed.');
                      }
                      onGeminiCredentialChanged?.();
                    } catch (err: any) {
                      setGeminiError(err?.message || 'Connection test failed.');
                    } finally {
                      setIsTestingGemini(false);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950/40 hover:bg-cyan-900/50 text-cyan-200 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40"
                >
                  {isTestingGemini ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  <span>{isTestingGemini ? 'Testing...' : 'Test Connection'}</span>
                </button>

                {geminiStatus?.hasSavedKey && (
                  <button
                    type="button"
                    data-testid="delete-gemini-key-btn"
                    disabled={isBusy}
                    onClick={async () => {
                      setGeminiError(null);
                      setGeminiSuccess(null);
                      setIsDeletingGemini(true);
                      try {
                        const updated = await projectApi.deleteGeminiCredential();
                        setGeminiStatus(updated);
                        setGeminiKeyInput('');
                        setShowDiscardConfirm(false);
                        setGeminiSuccess('Saved Gemini API key removed immediately.');
                        const refreshed = await projectApi.getPlanningReadiness();
                        setPlanningReadiness(refreshed);
                        onGeminiCredentialChanged?.();
                      } catch (err: any) {
                        setGeminiError(err?.message || 'Failed to remove saved Gemini API key.');
                      } finally {
                        setIsDeletingGemini(false);
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg border border-rose-500/40 bg-rose-950/30 hover:bg-rose-900/40 text-rose-300 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40"
                  >
                    {isDeletingGemini ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    <span>Remove Saved Key</span>
                  </button>
                )}
              </div>
              <span className="text-[10px] text-slate-500">
                Test sends a minimal Gemini request (may incur API usage).
              </span>
            </div>

            {(geminiStatus?.lastTestedAt || geminiStatus?.lastTestError) && (
              <div className="text-[11px] text-slate-400 pt-2 border-t border-slate-800/80 space-y-1">
                {geminiStatus.lastTestedAt && (
                  <div className="flex justify-between gap-2">
                    <span>Last Tested:</span>
                    <span className="font-mono text-slate-300">{new Date(geminiStatus.lastTestedAt).toLocaleString()}</span>
                  </div>
                )}
                {geminiStatus.lastTestError && (
                  <p className="text-rose-300 text-[11px]" data-testid="gemini-last-test-error">
                    Last Test Error: {geminiStatus.lastTestError}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Effective Runtime AI Planning Readiness */}
          <div className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2" data-testid="app-planning-readiness-card">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-indigo-400" />
                <span className="font-semibold text-white">Effective AI Planning Runtime</span>
              </div>
              {isLoadingReadiness || (!planningReadiness && !readinessLoadError) ? (
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700 inline-flex items-center gap-1">
                  <RotateCw className="w-3 h-3 animate-spin text-slate-400" />
                  <span>Checking...</span>
                </span>
              ) : readinessLoadError && !planningReadiness ? (
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
