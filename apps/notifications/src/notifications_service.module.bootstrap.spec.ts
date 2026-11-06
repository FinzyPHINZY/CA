import { compileRootModule } from '../../../test/bootstrap-module.helper';
import { NotificationsServiceModule } from './notifications_service.module';

describe('NotificationsServiceModule (bootstrap)', () => {
  it('resolves the DI graph', async () => {
    const moduleRef = await compileRootModule(NotificationsServiceModule);
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 30000);
});
