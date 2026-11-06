import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CharacterService } from './character.service';
import { CharacterController } from './character.controller';
import { Character, CharacterRepository } from '@app/common';

@Module({
  imports: [TypeOrmModule.forFeature([Character])],
  controllers: [CharacterController],
  providers: [CharacterService, CharacterRepository],
  exports: [CharacterService],
})
export class CharacterModule {}
