import { compileRootModule } from '../../../test/bootstrap-module.helper';
import { FileServiceModule } from './file_service.module';

describe('FileServiceModule (bootstrap)', () => {
  it('resolves the DI graph', async () => {
    const moduleRef = await compileRootModule(FileServiceModule);
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 30000);
});
