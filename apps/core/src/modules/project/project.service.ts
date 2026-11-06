import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import {
  AnalysisOutboxJob,
  AnalysisOutboxJobRepository,
  AnalysisOutboxStatus,
  MediaService,
  MediaType,
  ProjectRepository,
  SceneRepository,
  ScriptRepository,
  CharacterRepository,
  RecordingRepository,
  RehersalRepository,
  AiScriptAnalysisDTO,
  Script,
  ScriptStatus,
  Project,
  ProjectStatus,
  StorageService,
  SubscriptionPlan,
} from '@app/common';
import { CreateProjectDto } from './dto/create-project.dto';
import { AttachProjectScriptsDto } from './dto/attach-project-scripts.dto';
import { ListProjectOutboxJobsDto } from './dto/list-project-outbox-jobs.dto';
import { buildProjectAnalysisSummaryFromScripts } from './project-analysis-summary.util';
import { UpdateProjectDto } from './dto/update-project.dto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { AnalysisOutboxDispatcherService } from './analysis-outbox-dispatcher.service';
import { ScriptAnalysisProducerService } from './script-analysis-producer.service';
import { buildScriptAnalysisLifecycleSummary } from '../script/script-analysis-lifecycle.util';
import { PasteScriptDto } from './dto/paste-script.dto';
import { createHash } from 'crypto';

/**
 * Service responsible for project business logic
 * Follows Single Responsibility Principle - handles only project-related operations
 */
@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly sceneRepository: SceneRepository,
    private readonly scriptRepository: ScriptRepository,
    private readonly analysisOutboxJobRepository: AnalysisOutboxJobRepository,
    private readonly characterRepository: CharacterRepository,
    private readonly recordingRepository: RecordingRepository,
    private readonly rehersalRepository: RehersalRepository,
    private readonly mediaService: MediaService,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly scriptAnalysisProducer: ScriptAnalysisProducerService,
    private readonly storageService: StorageService,
  ) {}

  private get useBullMQ(): boolean {
    return this.configService.get<boolean>('USE_BULLMQ_DISPATCH', false);
  }

  /**
   * Create a new project with metadata only.
   * Script attachment and AI analysis are handled in a separate workflow.
   */
  async createProject(
    userId: string,
    createProjectDto: CreateProjectDto,
  ): Promise<any> {
    const project = this.projectRepository.create({
      userId,
      title: createProjectDto.title,
      description: createProjectDto.description || null,
      status: ProjectStatus.DRAFT,
    });
    const savedProject = await this.projectRepository.save(project);

    this.logger.log(`Project created: ${savedProject.id} by user ${userId}`);

    return {
      success: true,
      message: 'Project created successfully',
      data: savedProject,
    };
  }

  /**
   * Find project by ID with scripts and per-script statistics
   *
   * Each script includes:
   * - sceneCount:        number of scenes in the script
   * - characterCount:    number of characters in the script
   * - totalRecordings:   number of recordings linked to the script
   * - totalRehersals:    number of rehearsals linked to the script
   */
  async findById(id: string): Promise<any> {
    const project = await this.projectRepository.findById(id);
    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    // Load scripts for this project
    const scripts = await this.scriptRepository.find({
      where: { projectId: id },
    });

    // Enrich each script with statistics
    const scriptsWithStats = await Promise.all(
      scripts.map(async (script) => {
        const [sceneCount, characterCount, totalRecordings, totalRehersals] =
          await Promise.all([
            this.sceneRepository.countByScriptId(script.id),
            this.characterRepository.countByScriptId(script.id),
            this.recordingRepository.countByScriptId(script.id),
            this.rehersalRepository.countByScriptId(script.id),
          ]);

        return {
          ...script,
          analysisLifecycle: buildScriptAnalysisLifecycleSummary(script),
          sceneCount,
          characterCount,
          totalRecordings,
          totalRehersals,
        };
      }),
    );

    // Aggregate total scenes across all scripts
    let totalScenes = 0;
    for (const script of scriptsWithStats) {
      totalScenes += script.sceneCount;
    }

    const analysisSummary =
      buildProjectAnalysisSummaryFromScripts(scriptsWithStats);

    return {
      success: true,
      message: 'Project retrieved successfully',
      data: {
        ...project,
        ...analysisSummary,
        scripts: scriptsWithStats,
        totalScenes,
      },
    };
  }

  /**
   * Find all projects for a user with scripts and scene counts
   */
  async findByUserId(
    userId: string,
    status?: ProjectStatus,
  ): Promise<
    (Omit<Project, 'scripts'> & {
      scripts: Array<Script>;
      totalScenes: number;
      totalRecordings: number;
      totalRehersals: number;
    })[]
  > {
    const projects = await this.projectRepository.findByUserId(
      userId,
      false,
      status,
    );

    // Load scripts and count scenes for each project
    const projectsWithScripts = await Promise.all(
      projects.map(async (project) => {
        const scripts = await this.scriptRepository.find({
          where: { projectId: project.id },
        });
        const scriptsWithLifecycle = scripts.map((script) => ({
          ...script,
          analysisLifecycle: buildScriptAnalysisLifecycleSummary(script),
        }));

        let totalScenes = 0;
        let totalRecordings = 0;
        let totalRehersals = 0;
        for (const script of scripts) {
          const [sceneCount, recordingCount, rehersalCount] = await Promise.all(
            [
              this.sceneRepository.countByScriptId(script.id),
              this.recordingRepository.countByScriptId(script.id),
              this.rehersalRepository.countByScriptId(script.id),
            ],
          );
          totalScenes += sceneCount;
          totalRecordings += recordingCount;
          totalRehersals += rehersalCount;
        }

        return {
          ...project,
          ...buildProjectAnalysisSummaryFromScripts(scriptsWithLifecycle),
          scripts: scriptsWithLifecycle,
          totalScenes,
          totalRecordings,
          totalRehersals,
        };
      }),
    );

    return projectsWithScripts;
  }

  /**
   * Find projects for a user with pagination, search, sort, and filters
   */
  async findByUserIdWithPagination(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      status?: ProjectStatus;
      sortBy?: 'createdAt' | 'updatedAt' | 'title';
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    const paginationResult =
      await this.projectRepository.findByUserIdWithPagination(userId, options);

    // Load scripts and count scenes for each project
    const projectsWithScripts = await Promise.all(
      paginationResult.data.map(async (project) => {
        const scripts = await this.scriptRepository.find({
          where: { projectId: project.id },
        });
        const scriptsWithLifecycle = scripts.map((script) => ({
          ...script,
          analysisLifecycle: buildScriptAnalysisLifecycleSummary(script),
        }));

        let totalScenes = 0;
        let totalRecordings = 0;
        let totalRehersals = 0;
        for (const script of scripts) {
          const [sceneCount, recordingCount, rehersalCount] = await Promise.all(
            [
              this.sceneRepository.countByScriptId(script.id),
              this.recordingRepository.countByScriptId(script.id),
              this.rehersalRepository.countByScriptId(script.id),
            ],
          );
          totalScenes += sceneCount;
          totalRecordings += recordingCount;
          totalRehersals += rehersalCount;
        }

        return {
          ...project,
          ...buildProjectAnalysisSummaryFromScripts(scriptsWithLifecycle),
          scripts: scriptsWithLifecycle,
          totalScenes,
          totalRecordings,
          totalRehersals,
        };
      }),
    );

    const totalPages = Math.ceil(
      paginationResult.total / paginationResult.limit,
    );
    const hasNext = paginationResult.page < totalPages;
    const hasPrev = paginationResult.page > 1;

    return {
      success: true,
      message: 'Projects retrieved successfully',
      data: {
        items: projectsWithScripts,
        total: paginationResult.total,
        page: paginationResult.page,
        limit: paginationResult.limit,
        totalPages,
        hasNext,
        hasPrev,
      },
    };
  }

  /**
   * Find projects by script ID
   */
  async findByScriptId(scriptId: string): Promise<Script> {
    const script = await this.scriptRepository.findById(scriptId);
    if (!script || !script.projectId) {
      throw new NotFoundException(`Script with ID ${scriptId} not found`);
    }
    return script;
  }

  /**
   * Find projects by script ID with pagination, search, sort, and filters
   */
  async findByScriptIdWithPagination(
    scriptId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: 'createdAt' | 'updatedAt' | 'title';
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    const script = await this.scriptRepository.findById(scriptId);
    if (!script || !script.projectId) {
      return {
        success: true,
        message: 'Projects retrieved successfully',
        data: {
          items: [],
          total: 0,
          page: options.page || 1,
          limit: options.limit || 10,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
    }

    const project = await this.projectRepository.findById(script.projectId);
    if (!project) {
      return {
        success: true,
        message: 'Projects retrieved successfully',
        data: {
          items: [],
          total: 0,
          page: options.page || 1,
          limit: options.limit || 10,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
    }

    // Load scripts and count scenes
    const scripts = await this.scriptRepository.find({
      where: { projectId: project.id },
    });

    let totalScenes = 0;
    for (const s of scripts) {
      const sceneCount = await this.sceneRepository.countByScriptId(s.id);
      totalScenes += sceneCount;
    }

    const analysisSummary = buildProjectAnalysisSummaryFromScripts(scripts);

    return {
      success: true,
      message: 'Projects retrieved successfully',
      data: {
        items: [{ ...project, ...analysisSummary, scripts, totalScenes }],
        total: 1,
        page: options.page || 1,
        limit: options.limit || 10,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    };
  }

  /**
   * Update project and handle new scripts if provided
   */
  async updateProject(
    userId: string,
    id: string,
    updateProjectDto: UpdateProjectDto,
  ): Promise<any> {
    const project = await this.findOwnedProjectOrThrow(userId, id);

    // Update basic project fields
    // NOTE: Project title is only updated if explicitly provided in the DTO.
    // Uploading scripts (newMediaIds) should NEVER change the project title.
    const updateData: Partial<Project> = {};
    if (updateProjectDto.title !== undefined) {
      updateData.title = updateProjectDto.title;
    }
    if (updateProjectDto.description !== undefined) {
      updateData.description = updateProjectDto.description;
    }

    const updated = await this.projectRepository.updateProject(id, updateData);
    if (!updated) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    // Handle new scripts if provided
    // NOTE: Adding scripts does NOT modify the project title - it remains unchanged
    if (
      updateProjectDto.newMediaIds &&
      updateProjectDto.newMediaIds.length > 0
    ) {
      this.logger.warn(
        `Deprecated project update compatibility path used for project ${id}; prefer POST /projects/${id}/scripts`,
      );
      await this.attachScriptsToProject(userId, id, {
        mediaIds: updateProjectDto.newMediaIds,
      });
    }

    this.logger.log(`Project updated: ${id}`);
    return this.findById(id);
  }

  async attachScriptsToProject(
    userId: string,
    projectId: string,
    attachProjectScriptsDto: AttachProjectScriptsDto,
  ): Promise<any> {
    const project = await this.findOwnedProjectOrThrow(userId, projectId);
    const requestedMediaIds = attachProjectScriptsDto.mediaIds;
    const deduplicatedMediaIds = [...new Set(requestedMediaIds)];

    const attachmentResult = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const projectRepo = manager.getRepository(Project);
        const scriptRepo = manager.getRepository(Script);
        const analysisOutboxRepo = manager.getRepository(AnalysisOutboxJob);
        const existingScripts = await scriptRepo.find({
          where: { projectId },
        });

        const inFlightCount = existingScripts.filter((s) =>
          ProjectService.IN_FLIGHT_STATUSES.includes(s.status as ScriptStatus),
        ).length;

        if (inFlightCount >= ProjectService.MAX_CONCURRENT_PROCESSING) {
          throw new BadRequestException(
            `A project can have at most ${ProjectService.MAX_CONCURRENT_PROCESSING} scripts uploading/processing at the same time. ` +
              `This project currently has ${inFlightCount} script(s) in progress. Please wait for them to complete.`,
          );
        }

        const existingFileUrls = new Set(
          existingScripts.map((script) => script.fileUrl),
        );
        const existingSourceMediaIds = new Set(
          existingScripts
            .map((script) => script.sourceMediaId)
            .filter((value): value is string => Boolean(value)),
        );
        const createdScripts: Array<Script & { mediaId: string }> = [];
        const skippedMediaIds: string[] = [];
        let outboxJobsCreated = 0;

        for (let index = 0; index < deduplicatedMediaIds.length; index++) {
          const mediaId = deduplicatedMediaIds[index];
          const media = await this.mediaService.findById(mediaId);
          if (media.userId !== project.userId) {
            throw new ForbiddenException(
              `You are not authorized to use media ${mediaId}`,
            );
          }

          if (
            existingSourceMediaIds.has(media.id) ||
            existingFileUrls.has(media.url)
          ) {
            skippedMediaIds.push(mediaId);
            this.logger.log(
              `Script already exists for media ${mediaId}, skipping`,
            );
            continue;
          }

          if (
            inFlightCount + createdScripts.length >=
            ProjectService.MAX_CONCURRENT_PROCESSING
          ) {
            throw new BadRequestException(
              `A project can have at most ${ProjectService.MAX_CONCURRENT_PROCESSING} scripts uploading/processing at the same time. ` +
                `This project currently has ${inFlightCount} script(s) in progress and you are trying to add too many new scripts.`,
            );
          }

          const taskId = await this.generateUniqueTaskId(scriptRepo);
          const script = scriptRepo.create({
            title:
              media.fileName ||
              `Script ${existingScripts.length + createdScripts.length + 1}`,
            userId: project.userId,
            projectId,
            taskId,
            sourceMediaId: media.id,
            fileUrl: media.url,
            status: ScriptStatus.UPLOADED,
          });
          const savedScript = await scriptRepo.save(script);

          const payload: AiScriptAnalysisDTO = {
            projectId,
            userId: project.userId,
            mediaId: media.id,
            taskId: savedScript.taskId,
            scriptIndex: existingScripts.length + createdScripts.length,
          };

          const outboxJob = analysisOutboxRepo.create({
            eventType: 'ai.script-analysis',
            projectId,
            scriptId: savedScript.id,
            taskId: savedScript.taskId,
            status: AnalysisOutboxStatus.PENDING,
            payload,
          });
          await analysisOutboxRepo.save(outboxJob);
          outboxJobsCreated += 1;

          existingSourceMediaIds.add(media.id);
          existingFileUrls.add(media.url);
          createdScripts.push({ ...savedScript, mediaId });

          this.logger.log(
            `Script ${savedScript.id} created and analysis queued for media ${mediaId} (project: ${projectId})`,
          );
        }

        if (createdScripts.length > 0) {
          await projectRepo.update(
            { id: projectId },
            { status: ProjectStatus.ACTIVE },
          );
        }

        return {
          createdScripts,
          skippedMediaIds,
          outboxJobsCreated,
        };
      },
    );

    // When BullMQ dispatch is enabled, enqueue jobs after the transaction commits.
    // The outbox row remains as a safety net — the dispatcher will skip jobs
    // that were already processed via BullMQ (idempotency on task_id).
    if (this.useBullMQ && attachmentResult.createdScripts.length > 0) {
      for (const script of attachmentResult.createdScripts) {
        const media = await this.mediaService.findById(script.mediaId);
        await this.scriptAnalysisProducer.enqueueWithDefaults({
          projectId,
          userId: project.userId,
          mediaId: script.mediaId,
          taskId: script.taskId,
          scriptId: script.id,
          scriptIndex: attachmentResult.createdScripts.indexOf(script),
          fileSize: media?.size ?? 0,
          plan: project.userId
            ? await this.lookupUserPlan(project.userId)
            : undefined,
        });
      }
    }

    return {
      success: true,
      message:
        attachmentResult.createdScripts.length > 0
          ? 'Scripts attached successfully'
          : 'No new scripts were attached',
      data: {
        projectId,
        requestedMediaIds,
        deduplicatedMediaIds,
        createdScripts: attachmentResult.createdScripts,
        skippedMediaIds: attachmentResult.skippedMediaIds,
        outboxJobsCreated: attachmentResult.outboxJobsCreated,
      },
    };
  }

  async pasteScriptToProject(
    userId: string,
    projectId: string,
    dto: PasteScriptDto,
  ): Promise<any> {
    const project = await this.findOwnedProjectOrThrow(userId, projectId);

    // Content hash for deduplication
    const contentHash = createHash('sha256').update(dto.text).digest('hex');

    // Check for duplicate content in this project
    const existing = await this.scriptRepository.findByProjectIdAndContentHash(
      projectId,
      contentHash,
    );
    if (existing) {
      throw new ConflictException(
        'This exact script text has already been added to this project',
      );
    }

    // Upload text to S3 as .txt file
    const timestamp = Date.now();
    const sanitizedTitle = dto.title
      ?.replace(/[^a-zA-Z0-9_\-\s]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    const fileName = sanitizedTitle
      ? `${sanitizedTitle}.txt`
      : `pasted-script-${timestamp}.txt`;
    const buffer = Buffer.from(dto.text, 'utf-8');

    const { url, key } = await this.storageService.uploadBuffer(buffer, {
      keyPrefix: 'media/scripts',
      fileName,
      contentType: 'text/plain',
    });

    // Create Media record
    const media = await this.mediaService.createMedia({
      type: MediaType.DOCUMENT,
      url,
      size: buffer.length,
      userId,
      fileName,
      contentType: 'text/plain',
      s3Key: key,
    });

    const title =
      dto.title ||
      `Pasted Script - ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    // Transaction: create Script + AnalysisOutboxJob, update project status
    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const scriptRepo = manager.getRepository(Script);
        const analysisOutboxRepo = manager.getRepository(AnalysisOutboxJob);
        const projectRepo = manager.getRepository(Project);

        const inFlightScripts = await scriptRepo.count({
          where: {
            projectId,
            status: In(ProjectService.IN_FLIGHT_STATUSES),
          },
        });

        if (inFlightScripts >= ProjectService.MAX_CONCURRENT_PROCESSING) {
          throw new BadRequestException(
            `A project can have at most ${ProjectService.MAX_CONCURRENT_PROCESSING} scripts uploading/processing at the same time. ` +
              `This project currently has ${inFlightScripts} script(s) in progress. Please wait for them to complete.`,
          );
        }

        const totalScripts = await scriptRepo.count({
          where: { projectId },
        });

        const taskId = await this.generateUniqueTaskId(scriptRepo);

        const script = scriptRepo.create({
          title,
          userId,
          projectId,
          taskId,
          sourceMediaId: media.id,
          fileUrl: url,
          status: ScriptStatus.UPLOADED,
          contentHash,
        });
        const savedScript = await scriptRepo.save(script);

        const payload: AiScriptAnalysisDTO = {
          projectId,
          userId,
          mediaId: media.id,
          taskId: savedScript.taskId,
          scriptIndex: totalScripts,
        };

        const outboxJob = analysisOutboxRepo.create({
          eventType: 'ai.script-analysis',
          projectId,
          scriptId: savedScript.id,
          taskId: savedScript.taskId,
          status: AnalysisOutboxStatus.PENDING,
          payload,
        });
        await analysisOutboxRepo.save(outboxJob);

        if (project.status === ProjectStatus.DRAFT) {
          await projectRepo.update(
            { id: projectId },
            { status: ProjectStatus.ACTIVE },
          );
        }

        return savedScript;
      },
    );

    // BullMQ dispatch (mirrors attachScriptsToProject pattern)
    if (this.useBullMQ) {
      await this.scriptAnalysisProducer.enqueueWithDefaults({
        projectId,
        userId,
        mediaId: media.id,
        taskId: result.taskId,
        scriptId: result.id,
        scriptIndex: 0,
        fileSize: buffer.length,
        plan: await this.lookupUserPlan(userId),
      });
    }

    return {
      success: true,
      message: 'Script pasted and queued for analysis',
      data: {
        projectId,
        scriptId: result.id,
        mediaId: media.id,
        taskId: result.taskId,
        title: result.title,
        status: result.status,
        contentHash,
      },
    };
  }

  /**
   * Look up a user's current subscription plan. Falls back to FREE.
   */
  private async lookupUserPlan(userId: string): Promise<SubscriptionPlan> {
    try {
      const sub = await this.dataSource
        .getRepository('Subscription')
        .createQueryBuilder('sub')
        .where('sub.userId = :userId', { userId })
        .andWhere('sub.status = :status', { status: 'ACTIVE' })
        .orderBy('sub.createdAt', 'DESC')
        .getOne();
      return (sub as any)?.plan ?? SubscriptionPlan.FREE;
    } catch {
      return SubscriptionPlan.FREE;
    }
  }

  async retryProjectScriptAnalysis(
    userId: string,
    projectId: string,
    scriptId: string,
  ): Promise<any> {
    await this.findOwnedProjectOrThrow(userId, projectId);

    const retryResult = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const scriptRepo = manager.getRepository(Script);
        const analysisOutboxRepo = manager.getRepository(AnalysisOutboxJob);

        const script = await scriptRepo.findOne({
          where: { id: scriptId, projectId },
        });

        if (!script) {
          throw new NotFoundException(
            `Script ${scriptId} not found in project ${projectId}`,
          );
        }

        if (script.userId !== userId) {
          throw new ForbiddenException(
            `You are not authorized to retry script ${scriptId}`,
          );
        }

        if (script.status !== ScriptStatus.FAILED) {
          throw new BadRequestException('Only failed scripts can be retried');
        }

        if (!script.sourceMediaId) {
          throw new BadRequestException(
            'Cannot retry script analysis because the source media reference is missing',
          );
        }

        const taskId = await this.generateUniqueTaskId(scriptRepo);
        script.taskId = taskId;
        script.status = ScriptStatus.UPLOADED;
        script.analysisId = null;
        const savedScript = await scriptRepo.save(script);

        const payload: AiScriptAnalysisDTO = {
          projectId,
          userId,
          mediaId: script.sourceMediaId,
          taskId,
        };

        const siblingScripts = await scriptRepo.find({
          where: { projectId },
          order: { createdAt: 'ASC' },
        });
        payload.scriptIndex = siblingScripts.findIndex(
          (s) => s.id === scriptId,
        );

        const outboxJob = analysisOutboxRepo.create({
          eventType: 'ai.script-analysis',
          projectId,
          scriptId,
          taskId,
          status: AnalysisOutboxStatus.PENDING,
          payload,
        });
        const savedOutboxJob = await analysisOutboxRepo.save(outboxJob);

        this.logger.log(
          `Queued retry for script ${scriptId} in project ${projectId} with task ${taskId}`,
        );

        return {
          script: savedScript,
          outboxJob: savedOutboxJob,
        };
      },
    );

    // BullMQ dispatch for retry (mirrors attachScriptsToProject pattern)
    if (this.useBullMQ) {
      const media = await this.mediaService.findById(
        retryResult.script.sourceMediaId!,
      );
      await this.scriptAnalysisProducer.enqueueWithDefaults({
        projectId,
        userId,
        mediaId: retryResult.script.sourceMediaId!,
        taskId: retryResult.script.taskId,
        scriptId,
        fileSize: media?.size ?? 0,
        plan: await this.lookupUserPlan(userId),
      });
    }

    return {
      success: true,
      message: 'Script analysis retry queued successfully',
      data: {
        projectId,
        scriptId,
        taskId: retryResult.script.taskId,
        status: retryResult.script.status,
        outboxJobId: retryResult.outboxJob.id,
      },
    };
  }

  async getProjectOutboxJobsForAdmin(
    projectId: string,
    query: ListProjectOutboxJobsDto,
  ): Promise<any> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }
    return this.getProjectOutboxJobs(project.userId, projectId, query);
  }

  async retryProjectScriptAnalysisForAdmin(
    projectId: string,
    scriptId: string,
  ): Promise<any> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }
    return this.retryProjectScriptAnalysis(
      project.userId,
      projectId,
      scriptId,
    );
  }

  async getProjectOutboxJobs(
    userId: string,
    projectId: string,
    query: ListProjectOutboxJobsDto,
  ): Promise<any> {
    await this.findOwnedProjectOrThrow(userId, projectId);

    const staleBefore = new Date(
      Date.now() - AnalysisOutboxDispatcherService.STALE_AFTER_MS,
    );
    const statusCounts =
      await this.analysisOutboxJobRepository.getStatusCountsForProject(
        projectId,
      );
    const jobs = await this.analysisOutboxJobRepository.findProjectJobsForDebug(
      projectId,
      {
        status: query.status,
        includeDispatched: query.includeDispatched,
        onlyStuck: query.onlyStuck,
        limit: query.limit ?? 20,
        staleBefore,
      },
    );

    const items = jobs.map((job) => ({
      ...job,
      isStuck:
        job.status === AnalysisOutboxStatus.FAILED ||
        (job.status === AnalysisOutboxStatus.PROCESSING &&
          !!job.lastAttemptAt &&
          job.lastAttemptAt <= staleBefore) ||
        (job.status === AnalysisOutboxStatus.PENDING &&
          job.nextAttemptAt <= staleBefore),
    }));

    return {
      success: true,
      message: 'Project outbox jobs retrieved successfully',
      data: {
        projectId,
        staleAfterMs: AnalysisOutboxDispatcherService.STALE_AFTER_MS,
        filters: {
          status: query.status ?? null,
          includeDispatched: query.includeDispatched ?? false,
          onlyStuck: query.onlyStuck ?? false,
          limit: query.limit ?? 20,
        },
        summary: {
          totalJobs:
            statusCounts.PENDING +
            statusCounts.PROCESSING +
            statusCounts.DISPATCHED +
            statusCounts.FAILED,
          pendingJobs: statusCounts.PENDING,
          processingJobs: statusCounts.PROCESSING,
          dispatchedJobs: statusCounts.DISPATCHED,
          failedJobs: statusCounts.FAILED,
          stuckJobs: items.filter((job) => job.isStuck).length,
        },
        items,
      },
    };
  }

  /**
   * Soft delete project
   * Soft deletes the project so it won't be returned in queries.
   * Related entities (scripts, scenes, characters) remain but won't be accessible through the project.
   */
  async deleteProject(id: string): Promise<void> {
    await this.findById(id); // Verify project exists (will throw if not found or already soft-deleted)
    await this.projectRepository.softRemoveById(id);
    this.logger.log(`Project soft deleted: ${id}`);
  }

  /**
   * Get the last pending project for a user
   */
  async findLastPendingProject(userId: string): Promise<Project | null> {
    return this.projectRepository.findLastPendingByUserId(userId);
  }

  // maximum number of scripts that can be uploading/processing at the same time per project
  static readonly MAX_CONCURRENT_PROCESSING = 3;

  private static readonly IN_FLIGHT_STATUSES = [
    ScriptStatus.UPLOADED,
    ScriptStatus.PROCESSING,
    ScriptStatus.PARSING,
    ScriptStatus.ANALYZING,
  ];

  private async findOwnedProjectOrThrow(
    userId: string,
    projectId: string,
  ): Promise<Project> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }
    if (project.userId !== userId) {
      throw new ForbiddenException(
        `You are not authorized to modify project ${projectId}`,
      );
    }
    return project;
  }

  private async generateUniqueTaskId(
    scriptRepo: Repository<Script>,
  ): Promise<string> {
    let taskId = randomUUID();
    while (true) {
      const taskIdExists = await scriptRepo.findOne({
        where: { taskId },
      });
      if (!taskIdExists) {
        return taskId;
      }
      taskId = randomUUID();
    }
  }
}
