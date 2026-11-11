import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  Project,
  ProjectSummary,
  CreateProjectRequest,
  ArchiveProjectResponse,
  ResetProjectRequest,
  ResetProjectResponse,
  ProvisionJiraRequest,
  ProvisionJiraResponse,
} from '../types/projectContract';
import {
  projectApi,
  getActiveProjectId,
  setActiveProjectId,
  onActiveProjectChange,
} from '../lib/projectApi';

interface ProjectContextValue {
  currentProject: Project | null;
  projects: ProjectSummary[];
  activeProjects: ProjectSummary[];
  archivedProjects: ProjectSummary[];
  isLoadingProjects: boolean;
  isSwitchingProject: boolean;
  projectError: string | null;
  isArchived: boolean;
  switchProject: (projectId: string) => Promise<void>;
  refreshProjects: () => Promise<void>;
  createProject: (req: CreateProjectRequest) => Promise<Project>;
  archiveProject: (projectId: string) => Promise<ArchiveProjectResponse>;
  resetProject: (projectId: string, req: ResetProjectRequest) => Promise<ResetProjectResponse>;
  provisionJira: (projectId: string, req: ProvisionJiraRequest) => Promise<ProvisionJiraResponse>;
  isCreateWizardOpen: boolean;
  setIsCreateWizardOpen: (open: boolean) => void;
  isLifecycleModalOpen: boolean;
  setIsLifecycleModalOpen: (open: boolean) => void;
  lifecycleActionType: 'archive' | 'reset';
  setLifecycleActionType: (type: 'archive' | 'reset') => void;
  targetLifecycleProject: Project | null;
  setTargetLifecycleProject: (proj: Project | null) => void;
  openResetModal: (proj?: Project) => void;
  openArchiveModal: (proj?: Project) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [isSwitchingProject, setIsSwitchingProject] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);

  // Modals state
  const [isCreateWizardOpen, setIsCreateWizardOpen] = useState(false);
  const [isLifecycleModalOpen, setIsLifecycleModalOpen] = useState(false);
  const [lifecycleActionType, setLifecycleActionType] = useState<'archive' | 'reset'>('reset');
  const [targetLifecycleProject, setTargetLifecycleProject] = useState<Project | null>(null);

  // Stale-response guard: monotonic epoch ensures an older request never populates the workspace
  const switchEpochRef = useRef(0);
  const abortCtrlRef = useRef<AbortController | null>(null);

  const refreshProjects = useCallback(async () => {
    setIsLoadingProjects(true);
    setProjectError(null);
    try {
      const list = await projectApi.listProjects();
      setProjects(list);

      // Determine active project if none or if current is missing
      const activeId = getActiveProjectId();
      const targetId = activeId || (list.length > 0 ? list[0].id : 'default');

      if (!activeId && targetId) {
        setActiveProjectId(targetId);
      }

      // Fetch full details of target project
      try {
        const full = await projectApi.getProject(targetId);
        setCurrentProject(full);
      } catch (err: any) {
        if (list.length > 0) {
          const fallback = await projectApi.getProject(list[0].id);
          setActiveProjectId(list[0].id);
          setCurrentProject(fallback);
        }
      }
    } catch (err: any) {
      setProjectError(err.message || 'Failed to load projects');
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  // Switch to another project with race-condition protection and stale response abortion
  const switchProject = useCallback(async (targetProjectId: string) => {
    if (currentProject?.id === targetProjectId) return;

    // 1. Invalidate previous ongoing switch requests
    switchEpochRef.current += 1;
    const epoch = switchEpochRef.current;

    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
    }
    const abortCtrl = new AbortController();
    abortCtrlRef.current = abortCtrl;

    setIsSwitchingProject(true);
    setProjectError(null);

    // 2. Update client session storage
    setActiveProjectId(targetProjectId);

    try {
      const full = await projectApi.getProject(targetProjectId, abortCtrl.signal);
      // Verify we are still in the same epoch
      if (epoch === switchEpochRef.current) {
        setCurrentProject(full);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      if (epoch === switchEpochRef.current) {
        setProjectError(err.message || `Failed to switch to project ${targetProjectId}`);
      }
    } finally {
      if (epoch === switchEpochRef.current) {
        setIsSwitchingProject(false);
      }
    }
  }, [currentProject?.id]);

  // Initial load
  useEffect(() => {
    refreshProjects();

    const unsubscribe = onActiveProjectChange((newId) => {
      if (newId && newId !== currentProject?.id) {
        switchProject(newId);
      }
    });

    return () => {
      unsubscribe();
      if (abortCtrlRef.current) {
        abortCtrlRef.current.abort();
      }
    };
  }, []);

  const createProject = useCallback(async (req: CreateProjectRequest): Promise<Project> => {
    const created = await projectApi.createProject(req);
    await refreshProjects();
    await switchProject(created.id);
    return created;
  }, [refreshProjects, switchProject]);

  const archiveProject = useCallback(async (projectId: string): Promise<ArchiveProjectResponse> => {
    const res = await projectApi.archiveProject(projectId);
    await refreshProjects();
    if (currentProject?.id === projectId) {
      const updated = await projectApi.getProject(projectId);
      setCurrentProject(updated);
    }
    return res;
  }, [currentProject?.id, refreshProjects]);

  const resetProject = useCallback(async (projectId: string, req: ResetProjectRequest): Promise<ResetProjectResponse> => {
    const res = await projectApi.resetProject(projectId, req);
    await refreshProjects();
    if (currentProject?.id === projectId) {
      const updated = await projectApi.getProject(projectId);
      setCurrentProject(updated);
    }
    return res;
  }, [currentProject?.id, refreshProjects]);

  const provisionJira = useCallback(async (projectId: string, req: ProvisionJiraRequest): Promise<ProvisionJiraResponse> => {
    const res = await projectApi.provisionJira(projectId, req);
    await refreshProjects();
    if (currentProject?.id === projectId) {
      const updated = await projectApi.getProject(projectId);
      setCurrentProject(updated);
    }
    return res;
  }, [currentProject?.id, refreshProjects]);

  const openResetModal = useCallback((proj?: Project) => {
    setTargetLifecycleProject(proj || currentProject);
    setLifecycleActionType('reset');
    setIsLifecycleModalOpen(true);
  }, [currentProject]);

  const openArchiveModal = useCallback((proj?: Project) => {
    setTargetLifecycleProject(proj || currentProject);
    setLifecycleActionType('archive');
    setIsLifecycleModalOpen(true);
  }, [currentProject]);

  const activeProjects = projects.filter((p) => p.status === 'active');
  const archivedProjects = projects.filter((p) => p.status === 'archived');
  const isArchived = currentProject?.status === 'archived';

  return (
    <ProjectContext.Provider
      value={{
        currentProject,
        projects,
        activeProjects,
        archivedProjects,
        isLoadingProjects,
        isSwitchingProject,
        projectError,
        isArchived,
        switchProject,
        refreshProjects,
        createProject,
        archiveProject,
        resetProject,
        provisionJira,
        isCreateWizardOpen,
        setIsCreateWizardOpen,
        isLifecycleModalOpen,
        setIsLifecycleModalOpen,
        lifecycleActionType,
        setLifecycleActionType,
        targetLifecycleProject,
        setTargetLifecycleProject,
        openResetModal,
        openArchiveModal,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = (): ProjectContextValue => {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return ctx;
};
