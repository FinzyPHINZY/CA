/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import {
  AnalysisOutboxJob,
  AnalysisOutboxStatus,
  ProjectStatus,
  Script,
  ScriptStatus,
} from '@app/common';
import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Project } from '@app/common';
import { ProjectService } from './project.service';

function createRepo(overrides: Record<string, jest.Mock> = {}) {
  return {
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => data),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    ...overrides,
  };
}

describe('ProjectService', () => {
  let service: ProjectService;
  let projectRepository: any;
  let sceneRepository: any;
  let scriptRepository: any;
  let analysisOutboxJobRepository: any;
  let characterRepository: any;
  let recordingRepository: any;
  let rehersalRepository: any;
  let mediaService: any;
  let dataSource: any;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    projectRepository = {
      create: jest.fn((data) => data),
      save: jest.fn(),
      findById: jest.fn(),
      updateProject: jest.fn(),
    };
    sceneRepository = { countByScriptId: jest.fn() };
    scriptRepository = { find: jest.fn() };
    analysisOutboxJobRepository = {
      getStatusCountsForProject: jest.fn(),
      findProjectJobsForDebug: jest.fn(),
    };
    characterRepository = { countByScriptId: jest.fn() };
    recordingRepository = { countByScriptId: jest.fn() };
    rehersalRepository = { countByScriptId: jest.fn() };
    mediaService = { findById: jest.fn() };
    dataSource = { transaction: jest.fn() };

    service = new ProjectService(
      projectRepository,
      sceneRepository,
      scriptRepository,
      analysisOutboxJobRepository,
      characterRepository,
      recordingRepository,
      rehersalRepository,
      mediaService,
      dataSource,
      { get: jest.fn().mockReturnValue(false) } as any,
      { enqueue: jest.fn(), enqueueWithDefaults: jest.fn() } as any,
      { uploadBuffer: jest.fn() } as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates metadata-only projects in DRAFT', async () => {
    projectRepository.save.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      title: 'Project',
      description: null,
      status: ProjectStatus.DRAFT,
    });

    const result = await service.createProject('user-1', {
      title: 'Project',
    });

    expect(projectRepository.create).toHaveBeenCalledWith({
      userId: 'user-1',
      title: 'Project',
      description: null,
      status: ProjectStatus.DRAFT,
    });
    expect(result.data.status).toBe(ProjectStatus.DRAFT);
  });

  it('attaches only new scripts, deduplicates request media, and creates outbox jobs', async () => {
    projectRepository.findById.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      status: ProjectStatus.DRAFT,
    });

    const projectRepo = createRepo();
    const scriptRepo = createRepo({
      find: jest.fn().mockResolvedValue([
        {
          id: 'existing-script',
          projectId: 'project-1',
          sourceMediaId: 'media-2',
          fileUrl: 'https://cdn/media-2.pdf',
        },
      ]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValueOnce({
        id: 'script-1',
        projectId: 'project-1',
        taskId: 'task-1',
        status: ScriptStatus.UPLOADED,
      }),
    });
    const outboxRepo = createRepo({
      save: jest.fn().mockResolvedValue({
        id: 'outbox-1',
        status: AnalysisOutboxStatus.PENDING,
      }),
    });

    dataSource.transaction.mockImplementation(async (callback: any) =>
      callback({
        getRepository: jest.fn((entity: any) => {
          if (entity === Project) return projectRepo;
          if (entity === Script) return scriptRepo;
          if (entity === AnalysisOutboxJob) return outboxRepo;
          throw new Error(`Unexpected repository request for ${entity.name}`);
        }),
      }),
    );

    mediaService.findById
      .mockResolvedValueOnce({
        id: 'media-1',
        userId: 'user-1',
        fileName: 'Scene One',
        url: 'https://cdn/media-1.pdf',
      })
      .mockResolvedValueOnce({
        id: 'media-2',
        userId: 'user-1',
        fileName: 'Scene Two',
        url: 'https://cdn/media-2.pdf',
      });

    const result = await service.attachScriptsToProject('user-1', 'project-1', {
      mediaIds: ['media-1', 'media-1', 'media-2'],
    });

    expect(result.data.requestedMediaIds).toEqual([
      'media-1',
      'media-1',
      'media-2',
    ]);
    expect(result.data.deduplicatedMediaIds).toEqual(['media-1', 'media-2']);
    expect(result.data.skippedMediaIds).toEqual(['media-2']);
    expect(result.data.outboxJobsCreated).toBe(1);
    expect(result.data.createdScripts).toHaveLength(1);
    expect(scriptRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sourceMediaId: 'media-1',
        status: ScriptStatus.UPLOADED,
      }),
    );
    expect(outboxRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ai.script-analysis',
        projectId: 'project-1',
        scriptId: 'script-1',
      }),
    );
    expect(projectRepo.update).toHaveBeenCalledWith(
      { id: 'project-1' },
      { status: ProjectStatus.ACTIVE },
    );
  });

  it('queues a retry for failed project scripts', async () => {
    projectRepository.findById.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      status: ProjectStatus.ACTIVE,
    });

    const scriptRepo = createRepo({
      findOne: jest
        .fn()
        .mockResolvedValueOnce({
          id: 'script-1',
          projectId: 'project-1',
          userId: 'user-1',
          status: ScriptStatus.FAILED,
          sourceMediaId: 'media-1',
          taskId: 'old-task',
          analysisId: 'analysis-1',
        })
        .mockResolvedValueOnce(null),
      find: jest
        .fn()
        .mockResolvedValue([
          { id: 'script-1', createdAt: new Date('2026-01-01T00:00:00Z') },
        ]),
      save: jest.fn().mockImplementation(async (script) => script),
    });
    const outboxRepo = createRepo({
      save: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
    });

    dataSource.transaction.mockImplementation(async (callback: any) =>
      callback({
        getRepository: jest.fn((entity: any) => {
          if (entity === Script) return scriptRepo;
          if (entity === AnalysisOutboxJob) return outboxRepo;
          throw new Error(`Unexpected repository request for ${entity.name}`);
        }),
      }),
    );

    const result = await service.retryProjectScriptAnalysis(
      'user-1',
      'project-1',
      'script-1',
    );

    expect(scriptRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'script-1',
        status: ScriptStatus.UPLOADED,
        analysisId: null,
        taskId: expect.any(String),
      }),
    );
    expect(outboxRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ai.script-analysis',
        projectId: 'project-1',
        scriptId: 'script-1',
        status: AnalysisOutboxStatus.PENDING,
      }),
    );
    expect(result.data.scriptId).toBe('script-1');
    expect(result.data.status).toBe(ScriptStatus.UPLOADED);
    expect(result.data.outboxJobId).toBe('outbox-1');
  });

  it('rejects retries for scripts that are not failed', async () => {
    projectRepository.findById.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      status: ProjectStatus.ACTIVE,
    });

    const scriptRepo = createRepo({
      findOne: jest.fn().mockResolvedValue({
        id: 'script-1',
        projectId: 'project-1',
        userId: 'user-1',
        status: ScriptStatus.ANALYZED,
        sourceMediaId: 'media-1',
      }),
    });

    dataSource.transaction.mockImplementation(async (callback: any) =>
      callback({
        getRepository: jest.fn((entity: any) => {
          if (entity === Script) return scriptRepo;
          if (entity === AnalysisOutboxJob) return createRepo();
          throw new Error(`Unexpected repository request for ${entity.name}`);
        }),
      }),
    );

    await expect(
      service.retryProjectScriptAnalysis('user-1', 'project-1', 'script-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects attach when the project belongs to another user', async () => {
    projectRepository.findById.mockResolvedValue({
      id: 'project-1',
      userId: 'someone-else',
      status: ProjectStatus.DRAFT,
    });

    await expect(
      service.attachScriptsToProject('user-1', 'project-1', {
        mediaIds: ['media-1'],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns debug visibility for project outbox jobs', async () => {
    projectRepository.findById.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      status: ProjectStatus.ACTIVE,
    });
    analysisOutboxJobRepository.getStatusCountsForProject.mockResolvedValue({
      PENDING: 1,
      PROCESSING: 0,
      DISPATCHED: 1,
      FAILED: 1,
    });
    analysisOutboxJobRepository.findProjectJobsForDebug.mockResolvedValue([
      {
        id: 'outbox-1',
        projectId: 'project-1',
        status: AnalysisOutboxStatus.FAILED,
        attempts: 2,
        lastError: 'publish failed',
        lastAttemptAt: new Date('2026-03-13T10:00:00.000Z'),
        nextAttemptAt: new Date('2026-03-13T10:01:00.000Z'),
      },
    ]);

    const result = await service.getProjectOutboxJobs('user-1', 'project-1', {
      onlyStuck: true,
      limit: 10,
    });

    expect(
      analysisOutboxJobRepository.getStatusCountsForProject,
    ).toHaveBeenCalledWith('project-1');
    expect(
      analysisOutboxJobRepository.findProjectJobsForDebug,
    ).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        onlyStuck: true,
        limit: 10,
      }),
    );
    expect(result.data.summary.failedJobs).toBe(1);
    expect(result.data.items[0].isStuck).toBe(true);
  });

  it('uses attach workflow from updateProject when deprecated newMediaIds are provided', async () => {
    const attachScriptsToProjectSpy = jest
      .spyOn(service, 'attachScriptsToProject')
      .mockResolvedValue({
        success: true,
        message: 'Scripts attached successfully',
        data: {},
      });
    const findByIdSpy = jest.spyOn(service, 'findById').mockResolvedValue({
      success: true,
      message: 'Project retrieved successfully',
      data: { id: 'project-1' },
    });

    projectRepository.findById.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      title: 'Old Title',
      description: null,
      status: ProjectStatus.DRAFT,
    });
    projectRepository.updateProject.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      title: 'Updated Title',
      description: null,
      status: ProjectStatus.DRAFT,
    });

    await service.updateProject('user-1', 'project-1', {
      title: 'Updated Title',
      newMediaIds: ['media-1'],
    });

    expect(projectRepository.updateProject).toHaveBeenCalledWith('project-1', {
      title: 'Updated Title',
    });
    expect(attachScriptsToProjectSpy).toHaveBeenCalledWith(
      'user-1',
      'project-1',
      {
        mediaIds: ['media-1'],
      },
    );
    expect(findByIdSpy).toHaveBeenCalledWith('project-1');
  });

  it('throws when retrying a missing project script', async () => {
    projectRepository.findById.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      status: ProjectStatus.ACTIVE,
    });

    const scriptRepo = createRepo({
      findOne: jest.fn().mockResolvedValue(null),
    });

    dataSource.transaction.mockImplementation(async (callback: any) =>
      callback({
        getRepository: jest.fn((entity: any) => {
          if (entity === Script) return scriptRepo;
          if (entity === AnalysisOutboxJob) return createRepo();
          throw new Error(`Unexpected repository request for ${entity.name}`);
        }),
      }),
    );

    await expect(
      service.retryProjectScriptAnalysis('user-1', 'project-1', 'script-404'),
    ).rejects.toThrow(NotFoundException);
  });
});
