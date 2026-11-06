import { Module } from '@nestjs/common';
import { StaleSessionReaperService } from './stale-session-reaper.service';
import { HazelModule } from '../hazel/hazel.module';
import { TeleprompterModule } from '../teleprompter/teleprompter.module';

@Module({
  imports: [HazelModule, TeleprompterModule],
  providers: [StaleSessionReaperService],
})
export class SessionReaperModule {}
