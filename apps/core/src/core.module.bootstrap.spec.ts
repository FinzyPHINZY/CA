import { compileRootModule } from '../../../test/bootstrap-module.helper';
import { CoreModule } from './core.module';

describe('CoreModule (bootstrap)', () => {
  it('resolves the DI graph', async () => {
    const moduleRef = await compileRootModule(CoreModule);
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 60000);
});
