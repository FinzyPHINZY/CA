import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SceneService } from './scene.service';
import { SceneController } from './scene.controller';
import { Scene, SceneRepository, ScriptRepository } from '@app/common';

@Module({
  imports: [TypeOrmModule.forFeature([Scene])],
  controllers: [SceneController],
  providers: [SceneRepository, ScriptRepository, SceneService],
  exports: [SceneRepository, SceneService],
})
export class SceneModule {}
