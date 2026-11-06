/** biome-ignore-all lint/suspicious/noExplicitAny: test doubles are partial */
import { ScriptStatus } from '@app/common';
import { AnalysisStatus } from './entities/script-analysis.entity';
import { AnalysisResultHandlerService } from './analysis-result-handler.service';

describe('AnalysisResultHandlerService', () => {
  let service: AnalysisResultHandlerService;
  let analysisRepository: Record<string, jest.Mock>;
  let scriptRepository: Record<string, jest.Mock>;
  let projectRepository: Record<string, jest.Mock>;
  let aiClient: Record<string, jest.Mock>;
  let ack: jest.Mock;

  beforeEach(() => {
    analysisRepository = {
      findByTaskId: jest.fn(),
      updateAnalysis: jest.fn(),
      createAnalysis: jest.fn(),
    };
    scriptRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
    };
    projectRepository = {
      findOne: jest.fn(),
      update: jest.fn(),
    };
    aiClient = {
      emit: jest.fn(),
    };
    ack = jest.fn();

    service = new AnalysisResultHandlerService(
      analysisRepository as any,
      scriptRepository as any,
      projectRepository as any,
      aiClient as any,
    );
  });

  it('persists degraded-input rejection metadata on failed scripts', async () => {
    analysisRepository.findByTaskId.mockResolvedValue({
      id: 'analysis-1',
      scriptId: 'script-1',
    });
    scriptRepository.findOne.mockResolvedValue({
      id: 'script-1',
      projectId: null,
      status: ScriptStatus.PROCESSING,
      parserMetadata: {
        structuralWarnings: ['Existing warning'],
      },
    });
    scriptRepository.save.mockImplementation(async (script) => script);

    const context = {
      getChannelRef: () => ({ ack }),
      getMessage: () => ({ content: 'msg' }),
    } as any;

    await service.handleAnalysisResult(
      {
        taskId: 'task-1',
        userId: 'user-1',
        status: 'failed',
        error:
          'We couldn’t analyze this script reliably because the file is too visually degraded or heavily marked up. Please upload a cleaner PDF or original script export.',
        errorCode: 'VISUALLY_DEGRADED_INPUT',
        resultMetadata: {
          degradedInputClassification: {
            decision: 'unsupported_degraded',
            fileClass: 'marked_up_pdf',
            reasons: [
              'Page coverage ratio is too low for reliable analysis (0).',
            ],
            warnings: [],
            failureCode: 'VISUALLY_DEGRADED_INPUT',
            gateVersion: 'mvp_v1',
            evaluatedAt: '2026-03-16T18:00:00.000Z',
          },
          analysisLifecycle: {
            lifecycleState: 'failed',
            currentStage: 'failed',
            degraded: false,
            attentionRequired: true,
            fallbackUsed: false,
            failureStage: 'degraded_input_screening',
            failureCode: 'VISUALLY_DEGRADED_INPUT',
            failureMessage:
              'We couldn’t analyze this script reliably because the file is too visually degraded or heavily marked up. Please upload a cleaner PDF or original script export.',
            structuralPath: 'python_script_parser',
            semanticPath: 'gemini_scene_semantic',
            extractionSource: 'script_parser:pdf_text_heuristic',
            updatedAt: '2026-03-16T18:00:00.000Z',
          },
        },
      },
      context,
    );

    expect(analysisRepository.updateAnalysis).toHaveBeenCalledWith(
      'analysis-1',
      expect.objectContaining({
        status: AnalysisStatus.FAILED,
        error:
          'We couldn’t analyze this script reliably because the file is too visually degraded or heavily marked up. Please upload a cleaner PDF or original script export.',
      }),
    );

    expect(scriptRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ScriptStatus.FAILED,
        parserMetadata: expect.objectContaining({
          degradedInputClassification: expect.objectContaining({
            decision: 'unsupported_degraded',
            fileClass: 'marked_up_pdf',
            failureCode: 'VISUALLY_DEGRADED_INPUT',
          }),
          analysisLifecycle: expect.objectContaining({
            lifecycleState: 'failed',
            currentStage: 'failed',
            finalStatus: 'FAILED',
            degraded: false,
            attentionRequired: true,
            failureStage: 'degraded_input_screening',
            failureCode: 'VISUALLY_DEGRADED_INPUT',
          }),
        }),
      }),
    );

    expect(ack).toHaveBeenCalled();
  });
});
