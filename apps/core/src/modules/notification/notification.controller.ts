import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ValidationPipe,
  UseGuards,
  Req,
  Patch,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import { NotificationPaginationQueryDto } from './dto/pagination-query.dto';
import { JwtAuthGuard, NotificationType } from '@app/common';

@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Get all notifications for the authenticated user',
    description:
      'Retrieves paginated notifications for the authenticated user with support for search, filtering, and sorting. Supports filtering by notification type and read status, searching by title or body, and sorting by createdAt, updatedAt, title, or read status.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed)',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of items per page (1-100)',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term to filter notifications by title or body (case-insensitive)',
    example: 'analysis',
  })
  @ApiQuery({
    name: 'notificationType',
    required: false,
    enum: NotificationType,
    description: 'Filter by notification type',
    example: NotificationType.SCRIPT_ANALYSIS,
  })
  @ApiQuery({
    name: 'read',
    required: false,
    type: Boolean,
    description: 'Filter by read status',
    example: false,
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'title', 'read'],
    description: 'Field to sort by',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
    example: 'DESC',
  })
  @ApiOkResponse({
    description:
      'Paginated list of notifications found for the authenticated user',
    schema: {
      example: {
        success: true,
        message: 'Notifications retrieved successfully',
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 10,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async getMyNotifications(
    @Req() req: any,
    @Query(ValidationPipe) query: NotificationPaginationQueryDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.notificationService.findAllByUserId(userId, query);
  }

  @Get('me/unread')
  @ApiOperation({
    summary: 'Get unread notifications for the authenticated user',
    description:
      'Retrieves paginated unread notifications for the authenticated user with support for search, filtering, and sorting.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed)',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of items per page (1-100)',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term to filter notifications by title or body (case-insensitive)',
    example: 'analysis',
  })
  @ApiQuery({
    name: 'notificationType',
    required: false,
    enum: NotificationType,
    description: 'Filter by notification type',
    example: NotificationType.SCRIPT_ANALYSIS,
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'title'],
    description: 'Field to sort by',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated list of unread notifications',
    schema: {
      example: {
        success: true,
        message: 'Notifications retrieved successfully',
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 10,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async getMyUnreadNotifications(
    @Req() req: any,
    @Query(ValidationPipe) query: NotificationPaginationQueryDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.notificationService.findUnreadByUserId(userId, query);
  }

  @Get('me/statistics')
  @ApiOperation({
    summary: 'Get notification statistics for the authenticated user',
    description:
      'Retrieves statistics about notifications including total count, unread count, and count by notification type.',
  })
  @ApiOkResponse({
    description: 'Notification statistics',
    schema: {
      example: {
        success: true,
        message: 'Notification statistics retrieved successfully',
        data: {
          total: 25,
          unread: 5,
          byType: {
            'script-analysis': 15,
            subscription: 5,
            payment: 3,
            general: 2,
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async getMyStatistics(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.notificationService.getStatistics(userId);
  }

  @Get('task/:taskId')
  @ApiOperation({
    summary: 'Get notifications by task ID',
    description:
      'Retrieves paginated notifications associated with a specific task ID. Useful for tracking script analysis progress.',
  })
  @ApiParam({
    name: 'taskId',
    description: 'Task unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed)',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of items per page (1-100)',
    example: 10,
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'title'],
    description: 'Field to sort by',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated list of notifications for the task',
    schema: {
      example: {
        success: true,
        message: 'Notifications retrieved successfully',
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 10,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async getNotificationsByTaskId(
    @Param('taskId') taskId: string,
    @Req() req: any,
    @Query(ValidationPipe) query: NotificationPaginationQueryDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.notificationService.findByTaskId(taskId, userId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get notification by ID',
    description:
      'Retrieves a single notification by its unique identifier. The user must own the notification.',
  })
  @ApiParam({
    name: 'id',
    description: 'Notification unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Notification found and returned successfully',
    schema: {
      example: {
        success: true,
        message: 'Notification retrieved successfully',
        data: { id: 'uuid', title: '...', body: '...', read: false },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Notification not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description: 'User is not authorized to access this notification',
  })
  async getNotificationById(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.notificationService.findById(id, userId);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark notification as read',
    description:
      'Marks a specific notification as read. The user must own the notification.',
  })
  @ApiParam({
    name: 'id',
    description: 'Notification unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Notification marked as read successfully',
    schema: {
      example: {
        success: true,
        message: 'Notification marked as read successfully',
        data: { id: 'uuid', read: true },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Notification not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description: 'User is not authorized to mark this notification as read',
  })
  async markAsRead(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.notificationService.markAsRead(id, userId);
  }

  @Patch('me/read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark all notifications as read',
    description: 'Marks all notifications for the authenticated user as read.',
  })
  @ApiOkResponse({
    description: 'All notifications marked as read successfully',
    schema: {
      example: { success: true, message: 'All notifications marked as read' },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async markAllAsRead(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.notificationService.markAllAsRead(userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete notification',
    description:
      'Permanently deletes a notification. The user must own the notification. This action cannot be undone.',
  })
  @ApiParam({
    name: 'id',
    description: 'Notification unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiNoContentResponse({
    description: 'Notification deleted successfully. No content returned.',
  })
  @ApiNotFoundResponse({
    description: 'Notification not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description: 'User is not authorized to delete this notification',
  })
  async deleteNotification(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.notificationService.deleteById(id, userId);
  }
}
