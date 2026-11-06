/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { JwtAuthGuard } from '@app/common';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ReaderPublicProfileResponseDto } from './dto/reader-discovery-response.dto';
import { SearchReadersDto } from './dto/search-readers.dto';
import { ReaderDiscoveryService } from './reader-discovery.service';

@ApiTags('Reader Discovery')
@Controller('readers')
export class ReaderDiscoveryController {
  constructor(
    private readonly readerDiscoveryService: ReaderDiscoveryService,
  ) {}

  @Get('search')
  @ApiOperation({
    summary: 'Search readers with filters and pagination',
    description:
      'Search for readers with optional filters for genre, name, price range, rating, online status, and session status. ' +
      'Use `?isOnline=true&inSession=false` to find readers available for instant connect — ' +
      'this returns only readers who are currently online and not in an active session or pending a connect request.',
  })
  @ApiOkResponse({
    description: 'Paginated list of reader cards',
    schema: {
      example: {
        success: true,
        message: 'Readers retrieved successfully',
        data: {
          items: [
            {
              id: '33333333-3333-3333-3333-333333333333',
              readerName: 'Jane Smith',
              readerAvatar: 'https://cdn.example.com/avatar.jpg',
              headline: 'Award-winning voice actor',
              avgRating: 4.8,
              totalReviews: 42,
              totalSessions: 150,
              genres: ['Drama', 'Comedy'],
              startingPriceCents: 2500,
              currency: 'USD',
              isOnlineNow: true,
              inSession: false,
              isFavorited: false,
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
    },
  })
  async searchReaders(
    @Query(new ValidationPipe({ transform: true })) query: SearchReadersDto,
    @Req() req: any,
  ) {
    const actorUserId = req.user?.id;
    return this.readerDiscoveryService.searchReaders(query, actorUserId);
  }

  @Get('favorites')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List favorited readers (paginated, with online status)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiOkResponse({
    description: 'Paginated list of favorited reader cards',
    schema: {
      example: {
        success: true,
        message: 'Favorites retrieved successfully',
        data: {
          items: [
            {
              id: '33333333-3333-3333-3333-333333333333',
              readerName: 'Jane Smith',
              readerAvatar: 'https://cdn.example.com/avatar.jpg',
              headline: 'Award-winning voice actor',
              avgRating: 4.8,
              totalReviews: 42,
              totalSessions: 150,
              genres: ['Drama', 'Comedy'],
              startingPriceCents: 2500,
              currency: 'USD',
              isOnlineNow: true,
              inSession: false,
              isFavorited: true,
              favoritedAt: '2026-03-01T10:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async listFavorites(
    @Req() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.readerDiscoveryService.listFavorites(
      req.user.id,
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
    );
  }

  @Put('heartbeat')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send heartbeat to mark reader as online',
    description:
      'Sets a Redis presence key with a 60-second TTL. The client must call this ' +
      'endpoint repeatedly (every ~30s) to keep the reader appearing online. ' +
      'Stopping calls causes the reader to appear offline after TTL expiry. ' +
      'To go offline immediately, call DELETE /readers/heartbeat.',
  })
  @ApiOkResponse({
    description: 'Heartbeat recorded — reader is online',
    schema: {
      example: {
        success: true,
        message: 'Heartbeat recorded successfully',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async heartbeat(@Req() req: any) {
    return this.readerDiscoveryService.heartbeat(req.user.id);
  }

  @Delete('heartbeat')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark reader as offline immediately',
    description:
      'Deletes the Redis presence key so the reader appears offline instantly, ' +
      'rather than waiting for the 60s heartbeat TTL to expire. ' +
      'Call this on app close, logout, or when the reader manually sets themselves offline. ' +
      'Safe to call even if the reader is already offline — idempotent.',
  })
  @ApiOkResponse({
    description: 'Reader marked offline',
    schema: {
      example: {
        success: true,
        message: 'Reader is now offline',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async goOffline(@Req() req: any) {
    return this.readerDiscoveryService.goOffline(req.user.id);
  }

  @Get(':id/profile')
  @ApiOperation({ summary: 'Get public reader profile' })
  @ApiParam({ name: 'id', description: 'Reader profile ID (UUID)' })
  @ApiOkResponse({
    description: 'Full public reader profile',
    type: ReaderPublicProfileResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Reader profile not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  async getPublicProfile(@Param('id', ParseUUIDPipe) id: string) {
    return this.readerDiscoveryService.getPublicProfile(id);
  }

  @Post(':id/favorite')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Add reader to favorites' })
  @ApiParam({ name: 'id', description: 'Reader profile ID (UUID)' })
  @ApiOkResponse({
    description: 'Reader added to favorites',
    schema: {
      example: {
        success: true,
        message: 'Reader added to favorites',
        data: {
          id: 'uuid',
          userId: 'actor-uuid',
          readerProfileId: 'reader-uuid',
          createdAt: '2026-03-04T12:00:00.000Z',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Reader profile not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  @ApiConflictResponse({
    description: 'Reader already in favorites or cannot favorite own profile',
    schema: {
      example: {
        success: false,
        message: 'Reader already in favorites',
        statusCode: 409,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async addFavorite(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.readerDiscoveryService.addFavorite(req.user.id, id);
  }

  @Delete(':id/favorite')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove reader from favorites' })
  @ApiParam({ name: 'id', description: 'Reader profile ID (UUID)' })
  @ApiOkResponse({
    description: 'Reader removed from favorites',
    schema: {
      example: {
        success: true,
        message: 'Reader removed from favorites',
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Favorite not found',
    schema: {
      example: {
        success: false,
        message: 'Favorite not found',
        statusCode: 404,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async removeFavorite(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.readerDiscoveryService.removeFavorite(req.user.id, id);
  }
}
