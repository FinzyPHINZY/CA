/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import { JwtAuthGuard } from '@app/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';
import { DeleteTimeRangeDto } from './dto/delete-time-range.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';

@ApiTags('Availability')
@Controller('availability')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class AvailabilityController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  @Patch('me')
  @ApiOperation({
    summary: 'Create or update user availability',
    description:
      "Creates or updates the user's availability schedule. Each day can have multiple time ranges. If days are provided, existing time slots are cleared and replaced.",
  })
  @ApiBody({
    description: 'Availability data with days and time ranges',
    type: UpdateAvailabilityDto,
  })
  @ApiOkResponse({
    description: 'Availability updated successfully',
    schema: {
      example: {
        success: true,
        message: 'Availability updated successfully',
        data: {
          id: 'uuid',
          userId: 'uuid',
          days: [
            {
              dayOfWeek: 'MONDAY',
              timeRanges: [
                { id: 'uuid', startTime: '09:00', endTime: '12:00' },
              ],
            },
          ],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiBadRequestResponse({
    description: 'Invalid availability data or validation failed',
  })
  async updateAvailability(
    @Req() req: any,
    @Body(ValidationPipe) dto: UpdateAvailabilityDto,
  ) {
    const userId = req.user?.id;
    return this.availabilityService.updateAvailability(userId, dto);
  }

  @Get('me')
  @ApiOperation({
    summary: 'Get user availability',
    description:
      "Retrieves the current user's availability schedule with all days and time ranges.",
  })
  @ApiOkResponse({
    description: 'Availability retrieved successfully',
    schema: {
      example: {
        success: true,
        message: 'Availability retrieved successfully',
        data: {
          id: 'uuid',
          userId: 'uuid',
          days: [
            {
              dayOfWeek: 'MONDAY',
              timeRanges: [
                { id: 'uuid', startTime: '09:00', endTime: '12:00' },
              ],
            },
          ],
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async getAvailability(@Req() req: any) {
    const userId = req.user?.id;
    return this.availabilityService.getAvailability(userId);
  }

  @Delete('me/time-range')
  @ApiOperation({
    summary: 'Delete a specific time range from a day',
    description:
      "Deletes a specific time range from a particular day in the user's availability schedule.",
  })
  @ApiBody({
    description: 'Time range to delete',
    type: DeleteTimeRangeDto,
  })
  @ApiOkResponse({
    description: 'Time range deleted successfully',
    schema: {
      example: {
        success: true,
        message: 'Time range deleted successfully',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiNotFoundResponse({
    description: 'Availability or time range not found',
  })
  @ApiBadRequestResponse({
    description: 'Invalid time range data or validation failed',
  })
  async deleteTimeRange(
    @Req() req: any,
    @Body(ValidationPipe) dto: DeleteTimeRangeDto,
  ) {
    const userId = req.user?.id;
    return this.availabilityService.deleteTimeRange(userId, dto);
  }
}
