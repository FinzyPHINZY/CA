import { Injectable, Inject, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { AI_SERVICE } from '@app/common';

@Injectable()
export class CoreService {
  private readonly logger = new Logger(CoreService.name);

  constructor(@Inject(AI_SERVICE) private readonly aiClient: ClientProxy) {}

  getHello(): string {
    return 'Hello from ACR Core Service!';
  }


  async sendAnalysisJob(
    scriptId: string,
    scriptContent: string,
  ): Promise<void> {
    this.logger.log(
      `Sending analysis job for script ${scriptId} to AI service`,
    );
    try {
      await firstValueFrom(
        this.aiClient.send('ai.analyze', {
          scriptId,
          scriptContent,
        }),
      );
      this.logger.log(`Analysis job sent successfully for script ${scriptId}`);
    } catch (error) {
      this.logger.error(
        `Failed to send analysis job for script ${scriptId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }


  async emitAnalysisJob(
    scriptId: string,
    scriptContent: string,
  ): Promise<void> {
    this.logger.log(
      `Emitting analysis job for script ${scriptId} to AI service (fire and forget)`,
    );
    try {
      this.aiClient.emit('ai.analyze', {
        scriptId,
        scriptContent,
      });
      this.logger.log(
        `Analysis job emitted successfully for script ${scriptId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to emit analysis job for script ${scriptId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
