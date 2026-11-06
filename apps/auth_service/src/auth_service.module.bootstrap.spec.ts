import { compileRootModule } from '../../../test/bootstrap-module.helper';
import { AuthServiceModule } from './auth_service.module';

describe('AuthServiceModule (bootstrap)', () => {
  it('resolves the DI graph', async () => {
    const moduleRef = await compileRootModule(AuthServiceModule);
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 30000);
});
