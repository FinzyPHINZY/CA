/**
 * RehearsalListService
 *
 * Tells the story of fetching a user's rehearsals: we find them, filter them,
 * sort them, and return a page the caller can display.
 */
import { RehersalRepository, UserRepository } from '@app/common';
import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ListRehearsalsByUserIdQueryDto,
  RehearsalListSortBy,
} from './dto/list-rehearsals-by-user-query.dto';
import { RehearsalReadModelService } from './rehearsal-read-model.service';

@Injectable()
export class RehearsalListService {
  constructor(
    private readonly rehearsalRepository: RehersalRepository,
    private readonly userRepository: UserRepository,
    private readonly rehearsalReadModelService: RehearsalReadModelService,
  ) {}

  /**
   * List rehearsals for a user. First we ensure the user exists and is manageable,
   * then we fetch rehearsals with the given filters, and finally we shape each
   * row into a display-friendly format.
   */
  async listByUserId(
    userId: string,
    query: ListRehearsalsByUserIdQueryDto,
  ): Promise<any> {
    await this.ensureUserExists(userId);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const { rows, total } = await this.rehearsalRepository.findListByUserId(
      userId,
      {
        page,
        limit,
        search: query.search,
        status: query.status,
        partnerType: query.partnerType,
        projectId: query.projectId,
        sceneId: query.sceneId,
        createdFrom: query.createdFrom,
        createdTo: query.createdTo,
        sortBy: query.sortBy as RehearsalListSortBy,
        sortOrder: query.sortOrder,
      },
    );

    const items = await this.rehearsalReadModelService.buildList(rows);
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      success: true,
      message: 'Rehearsals retrieved successfully',
      data: {
        items,
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  private async ensureUserExists(userId: string): Promise<void> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
  }
}
