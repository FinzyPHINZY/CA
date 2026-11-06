import { compileRootModule } from '../../../test/bootstrap-module.helper';
import { AiServiceModule } from '../src/ai_service.module';

describe('AiServiceModule (bootstrap)', () => {
  it('resolves the DI graph', async () => {
    const moduleRef = await compileRootModule(AiServiceModule);
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 30000);
});
