import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  NotificationRepository,
  Notification,
  ScriptRepository,
} from '@app/common';
import { NotificationPaginationQueryDto } from './dto/pagination-query.dto';
import { PaginatedNotificationResponseDto } from './dto/paginated-response.dto';
import { Brackets } from 'typeorm';
import { ScriptAnalysisRepository } from '../analysis/repositories/script-analysis.repository';

/**
 * Service responsible for notification business logic
 * Handles all notification-related operations except creation (handled by notifications service)
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly notificationRepository: NotificationRepository,
    private readonly scriptRepository: ScriptRepository,
    private readonly scriptAnalysisRepository: ScriptAnalysisRepository,
  ) {}

  /**
   * Find all notifications for a user with pagination, search, sort, and filter
   */
  async findAllByUserId(
    userId: string,
    query: NotificationPaginationQueryDto,
  ): Promise<any> {
    const {
      page = 1,
      limit = 10,
      search,
      notificationType,
      read,
      sortBy,
      sortOrder,
    } = query;

    const queryBuilder = this.notificationRepository
      .createQueryBuilder('notification')
      .where('notification.recipientUserId = :userId', { userId })
      .andWhere('notification.deletedAt IS NULL');

    // Apply filters
    if (notificationType) {
      queryBuilder.andWhere(
        'notification.notificationType = :notificationType',
        {
          notificationType,
        },
      );
    }

    if (read !== undefined) {
      queryBuilder.andWhere('notification.read = :read', { read });
    }

    // Apply search
    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(notification.title) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(notification.body) LIKE LOWER(:search)', {
            search: `%${search}%`,
          });
        }),
      );
    }

    // Apply sorting
    const sortField = sortBy || 'createdAt';
    const order = sortOrder || 'DESC';
    queryBuilder.orderBy(`notification.${sortField}`, order);

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();
    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Notifications retrieved successfully',
      data: {
        items: data,
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  /**
   * Find notification by ID
   */
  async findById(id: string, userId: string): Promise<any> {
    const notification = await this.notificationRepository.findById(id);

    if (!notification) {
      throw new NotFoundException(`Notification with ID ${id} not found`);
    }

    // Ensure user owns the notification
    if (notification.recipientUserId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to access this notification',
      );
    }

    return {
      success: true,
      message: 'Notification retrieved successfully',
      data: notification,
    };
  }

  /**
   * Find notifications by taskId
   */
  async findByTaskId(
    taskId: string,
    userId: string,
    query: NotificationPaginationQueryDto,
  ): Promise<any> {
    const { page = 1, limit = 10, sortBy, sortOrder } = query;

    const queryBuilder = this.notificationRepository
      .createQueryBuilder('notification')
      .where('notification.taskId = :taskId', { taskId })
      .andWhere('notification.recipientUserId = :userId', { userId })
      .andWhere('notification.deletedAt IS NULL');

    // Apply sorting
    const sortField = sortBy || 'createdAt';
    const order = sortOrder || 'DESC';
    queryBuilder.orderBy(`notification.${sortField}`, order);

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();
    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Notifications retrieved successfully',
      data: {
        items: data,
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  /**
   * Find notifications by scriptId
   * Uses ScriptAnalysis to find taskId, then finds notifications by taskId
   */
  async findByScriptId(
    scriptId: string,
    userId: string,
    query: NotificationPaginationQueryDto,
  ): Promise<any> {
    // First, verify the script exists and belongs to the user
    const script = await this.scriptRepository.findById(scriptId);
    if (!script) {
      throw new NotFoundException(`Script with ID ${scriptId} not found`);
    }

    if (script.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to access notifications for this script',
      );
    }

    // Find ScriptAnalysis by scriptId to get taskId
    const analysis =
      await this.scriptAnalysisRepository.findByScriptId(scriptId);

    if (!analysis || !analysis.taskId) {
      // If no analysis exists, return empty result
      return {
        data: [],
        total: 0,
        page: query.page || 1,
        limit: query.limit || 10,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
    }

    // Find notifications by taskId
    return this.findByTaskId(analysis.taskId, userId, query);
  }

  /**
   * Find unread notifications for a user
   */
  async findUnreadByUserId(
    userId: string,
    query: NotificationPaginationQueryDto,
  ): Promise<any> {
    return this.findAllByUserId(userId, { ...query, read: false });
  }

  /**
   * Mark notification as read
   */
  async markAsRead(id: string, userId: string): Promise<any> {
    await this.findById(id, userId);
    await this.notificationRepository.markReadById(id);
    const updated = await this.notificationRepository.findById(id);
    return {
      success: true,
      message: 'Notification marked as read successfully',
      data: updated,
    };
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<any> {
    await this.notificationRepository.markAllReadForRecipient(userId);
    return { success: true, message: 'All notifications marked as read' };
  }

  /**
   * Delete notification by ID
   */
  async deleteById(id: string, userId: string): Promise<void> {
    const notification = await this.findById(id, userId);
    await this.notificationRepository.deleteById(id);
  }

  /**
   * Get notification statistics for a user
   */
  async getStatistics(userId: string): Promise<any> {
    const allNotifications = await this.notificationRepository.find({
      where: { recipientUserId: userId } as any,
    });

    const unread = allNotifications.filter((n) => !n.read).length;
    const byType: Record<string, number> = {};

    allNotifications.forEach((notification) => {
      const type = notification.notificationType;
      byType[type] = (byType[type] || 0) + 1;
    });

    return {
      success: true,
      message: 'Notification statistics retrieved successfully',
      data: { total: allNotifications.length, unread, byType },
    };
  }
}
