import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaService } from './media.service';
import { MediaRepository } from '../repositories/media.repository';
import { Media } from '../entities/media.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Media])],
  providers: [MediaRepository, MediaService],
  exports: [MediaService, MediaRepository],
})
export class MediaModule {}
