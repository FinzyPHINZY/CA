/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { AnalysisOutboxStatus, ScriptStatus } from '@app/common';
import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AnalysisOutboxDispatcherService } from './analysis-outbox-dispatcher.service';

describe('AnalysisOutboxDispatcherService', () => {
  let service: AnalysisOutboxDispatcherService;
  let analysisOutboxJobRepository: {
    claimDispatchableJobs: jest.Mock;
    markDispatched: jest.Mock;
    markFailed: jest.Mock;
  };
  let scriptRepository: {
    update: jest.Mock;
  };
  let aiClient: {
    emit: jest.Mock;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    analysisOutboxJobRepository = {
      claimDispatchableJobs: jest.fn(),
      markDispatched: jest.fn(),
      markFailed: jest.fn(),
    };
    scriptRepository = {
      update: jest.fn(),
    };
    aiClient = {
      emit: jest.fn(),
    };

    service = new AnalysisOutboxDispatcherService(
      analysisOutboxJobRepository as any,
      scriptRepository as any,
      aiClient as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dispatches pending jobs and marks scripts as processing', async () => {
    analysisOutboxJobRepository.claimDispatchableJobs.mockResolvedValue([
      {
        id: 'job-1',
        eventType: 'ai.script-analysis',
        payload: { taskId: 'task-1' },
        scriptId: 'script-1',
        attempts: 1,
      },
    ]);
    aiClient.emit.mockReturnValue(of(true));
    scriptRepository.update.mockResolvedValue(undefined);
    analysisOutboxJobRepository.markDispatched.mockResolvedValue(undefined);

    await service.dispatchPendingJobs();

    expect(aiClient.emit).toHaveBeenCalledWith(
      'ai.script-analysis',
      expect.objectContaining({ taskId: 'task-1' }),
    );
    expect(scriptRepository.update).toHaveBeenCalledWith('script-1', {
      status: ScriptStatus.PROCESSING,
    });
    expect(analysisOutboxJobRepository.markDispatched).toHaveBeenCalledWith(
      'job-1',
    );
    expect(analysisOutboxJobRepository.markFailed).not.toHaveBeenCalled();
  });

  it('marks jobs as failed with retry metadata when dispatch throws', async () => {
    analysisOutboxJobRepository.claimDispatchableJobs.mockResolvedValue([
      {
        id: 'job-1',
        eventType: 'ai.script-analysis',
        payload: { taskId: 'task-1' },
        scriptId: 'script-1',
        attempts: 2,
        status: AnalysisOutboxStatus.PROCESSING,
      },
    ]);
    aiClient.emit.mockReturnValue(
      throwError(() => new Error('broker unavailable')),
    );
    analysisOutboxJobRepository.markFailed.mockResolvedValue(undefined);

    await service.dispatchPendingJobs();

    expect(analysisOutboxJobRepository.markFailed).toHaveBeenCalledWith(
      'job-1',
      'broker unavailable',
      expect.any(Date),
    );
    expect(analysisOutboxJobRepository.markDispatched).not.toHaveBeenCalled();
    expect(scriptRepository.update).not.toHaveBeenCalled();
  });
});
