import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { Media } from './entities/media.entity';
import { MediaRepository } from './repositories/media.repository';

@Module({
  imports: [TypeOrmModule.forFeature([Media])],
  controllers: [MediaController],
  providers: [MediaRepository, MediaService],
  exports: [MediaService, MediaRepository],
})
export class MediaModule {}
