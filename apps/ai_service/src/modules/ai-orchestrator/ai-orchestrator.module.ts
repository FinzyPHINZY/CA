import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { GeminiSemaphoreService } from './gemini-semaphore.service';
import { FdxParserService } from './services/fdx-parser.service';
import { GeminiService } from './services/gemini.service';
import { GeminiProvider } from './services/providers/gemini.provider';
import {
  Script,
  Character,
  Scene,
  UsageRecord,
  ScriptRepository,
  CharacterRepository,
  SceneRepository,
  UsageRecordRepository,
  StorageModule,
} from '@app/common';
import { AdobeExtractService } from './services/extraction/adobe-extract.service';
import { DocumentAiExtractService } from './services/extraction/document-ai.service';
import { NativePdfExtractService } from './services/extraction/native-pdf-extract.service';
import { NativePdfWatermarkSuppressionService } from './services/extraction/native-pdf-watermark-suppression.service';
import { NativePdfQualityGateService } from './services/extraction/native-pdf-quality-gate.service';
import { StructuredExtractionNormalizer } from './services/extraction/structured-extraction-normalizer.service';
import { NativePdfCapabilityDetectorService } from './services/native-pdf-capability-detector.service';
import { NativePdfRoutingService } from './services/native-pdf-routing.service';

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([Script, Character, Scene, UsageRecord]),
    StorageModule,
  ],
  providers: [
    AiOrchestratorService,
    GeminiSemaphoreService,
    FdxParserService,
    GeminiService,
    GeminiProvider,
    ScriptRepository,
    CharacterRepository,
    SceneRepository,
    UsageRecordRepository,
    AdobeExtractService,
    DocumentAiExtractService,
    NativePdfExtractService,
    NativePdfWatermarkSuppressionService,
    NativePdfQualityGateService,
    StructuredExtractionNormalizer,
    NativePdfCapabilityDetectorService,
    NativePdfRoutingService,
  ],
  exports: [AiOrchestratorService],
})
export class AiOrchestratorModule {}
