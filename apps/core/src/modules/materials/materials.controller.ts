/** biome-ignore-all lint/style/useImportType: <> */

import { JwtAuthGuard, MaterialType } from '@app/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CreateMaterialDto } from './dto/create-material.dto';
import { MaterialsService } from './materials.service';

const MATERIAL_EXAMPLE = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  scriptId: '223e4567-e89b-12d3-a456-426614174001',
  projectId: '323e4567-e89b-12d3-a456-426614174002',
  userId: '423e4567-e89b-12d3-a456-426614174003',
  type: 'link',
  title: 'Character Reference Sheet',
  url: 'https://example.com/reference',
  textContent: null,
  fileKey: null,
  fileUrl: null,
  fileName: null,
  fileSizeBytes: null,
  mimeType: null,
  createdAt: '2026-03-27T10:00:00.000Z',
  updatedAt: '2026-03-27T10:00:00.000Z',
  deletedAt: null,
};

const UNAUTHORIZED_SCHEMA = {
  type: 'object',
  properties: {
    statusCode: { type: 'number', example: 401 },
    message: { type: 'string', example: 'Unauthorized' },
    error: { type: 'string', example: 'Unauthorized' },
  },
};

const NOT_FOUND_SCHEMA = (resource: string) => ({
  type: 'object',
  properties: {
    statusCode: { type: 'number', example: 404 },
    message: { type: 'string', example: `${resource} not found` },
    error: { type: 'string', example: 'Not Found' },
  },
});

const BAD_REQUEST_SCHEMA = (messages: string[]) => ({
  type: 'object',
  properties: {
    statusCode: { type: 'number', example: 400 },
    message: {
      oneOf: [
        { type: 'string', example: messages[0] },
        { type: 'array', items: { type: 'string' }, example: messages },
      ],
    },
    error: { type: 'string', example: 'Bad Request' },
  },
});

@ApiTags('Materials')
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MaterialsController {
  constructor(private readonly materialsService: MaterialsService) {}

  @Post('scripts/:scriptId/materials')
  @ApiOperation({
    summary: 'Add a material to a script',
    description:
      'Attaches a material (file, link, or text) to a script. ' +
      'For **file** materials, upload the file to file_service first and pass back the returned `fileKey`, `fileUrl`, and `fileName`. ' +
      'For **link** materials, provide `title` and `url`. ' +
      'For **text** materials, provide `title` and `textContent`. ' +
      'The `projectId` is automatically derived from the script — no need to pass it.',
  })
  @ApiParam({
    name: 'scriptId',
    description: 'UUID of the script to attach the material to',
    type: 'string',
    format: 'uuid',
    example: '223e4567-e89b-12d3-a456-426614174001',
  })
  @ApiBody({ type: CreateMaterialDto })
  @ApiCreatedResponse({
    description: 'Material created and attached to the script',
    schema: {
      example: {
        success: true,
        message: 'Material added successfully',
        data: MATERIAL_EXAMPLE,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed — missing required fields for the given type, invalid URL, invalid UUID param, or script does not belong to a project',
    schema: {
      examples: {
        missing_url: {
          summary: 'Missing url for link type',
          value: {
            statusCode: 400,
            message: 'url is required for link materials',
            error: 'Bad Request',
          },
        },
        missing_text: {
          summary: 'Missing textContent for text type',
          value: {
            statusCode: 400,
            message: 'textContent is required for text materials',
            error: 'Bad Request',
          },
        },
        missing_file_fields: {
          summary: 'Missing file fields for file type',
          value: {
            statusCode: 400,
            message:
              'fileKey, fileUrl, and fileName are required for file materials',
            error: 'Bad Request',
          },
        },
        validation_errors: {
          summary: 'DTO validation errors',
          value: {
            statusCode: 400,
            message: [
              'type must be one of the following values: file, link, text',
              'title should not be empty',
            ],
            error: 'Bad Request',
          },
        },
        no_project: {
          summary: 'Script not attached to a project',
          value: {
            statusCode: 400,
            message: 'Script must belong to a project to add materials',
            error: 'Bad Request',
          },
        },
        invalid_uuid: {
          summary: 'Invalid UUID format in path',
          value: {
            statusCode: 400,
            message: 'Validation failed (uuid is expected)',
            error: 'Bad Request',
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: UNAUTHORIZED_SCHEMA,
  })
  @ApiNotFoundResponse({
    description:
      'Script not found or does not belong to the authenticated user',
    schema: NOT_FOUND_SCHEMA('Script'),
  })
  async addMaterial(
    @Req() req: any,
    @Param('scriptId', ParseUUIDPipe) scriptId: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: CreateMaterialDto,
  ) {
    const userId = req.user?.id;
    if (!userId)
      throw new UnauthorizedException('User ID not found in request');
    return this.materialsService.addMaterial(userId, scriptId, dto);
  }

  @Get('scripts/:scriptId/materials')
  @ApiOperation({
    summary: 'Get materials for a script',
    description:
      'Returns all materials attached to a script, ordered chronologically (oldest first). ' +
      'Optionally filter by `type` to retrieve only files, links, or text materials.',
  })
  @ApiParam({
    name: 'scriptId',
    description: 'UUID of the script',
    type: 'string',
    format: 'uuid',
    example: '223e4567-e89b-12d3-a456-426614174001',
  })
  @ApiQuery({
    name: 'type',
    description: 'Filter by material type',
    required: false,
    enum: MaterialType,
  })
  @ApiOkResponse({
    description:
      'Materials for the script. Returns an empty array if none exist.',
    schema: {
      example: {
        success: true,
        message: 'Materials retrieved successfully',
        data: [
          {
            ...MATERIAL_EXAMPLE,
            type: 'link',
            title: 'Character Reference Sheet',
            url: 'https://example.com/reference',
          },
          {
            ...MATERIAL_EXAMPLE,
            id: '523e4567-e89b-12d3-a456-426614174004',
            type: 'text',
            title: 'Backstory Notes',
            url: null,
            textContent:
              'My character is a 35-year-old detective with a troubled past...',
          },
          {
            ...MATERIAL_EXAMPLE,
            id: '623e4567-e89b-12d3-a456-426614174005',
            type: 'file',
            title: 'Costume Reference',
            url: null,
            fileKey: 'uploads/abc123/costume.pdf',
            fileUrl:
              'https://s3.amazonaws.com/bucket/uploads/abc123/costume.pdf',
            fileName: 'costume.pdf',
            fileSizeBytes: 204800,
            mimeType: 'application/pdf',
          },
        ],
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid UUID format for scriptId',
    schema: BAD_REQUEST_SCHEMA(['Validation failed (uuid is expected)']),
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: UNAUTHORIZED_SCHEMA,
  })
  @ApiNotFoundResponse({
    description:
      'Script not found or does not belong to the authenticated user',
    schema: NOT_FOUND_SCHEMA('Script'),
  })
  async getMaterialsByScript(
    @Req() req: any,
    @Param('scriptId', ParseUUIDPipe) scriptId: string,
    @Query('type') type?: string,
  ) {
    const userId = req.user?.id;
    if (!userId)
      throw new UnauthorizedException('User ID not found in request');
    return this.materialsService.getMaterialsByScript(userId, scriptId, type);
  }

  @Get('projects/:projectId/materials')
  @ApiOperation({
    summary: 'Get all materials in a project',
    description:
      'Returns all materials across every script in the project, ordered chronologically. ' +
      'Use `type` to filter by material type, or `scriptId` to narrow to a specific script within the project.',
  })
  @ApiParam({
    name: 'projectId',
    description: 'UUID of the project',
    type: 'string',
    format: 'uuid',
    example: '323e4567-e89b-12d3-a456-426614174002',
  })
  @ApiQuery({
    name: 'type',
    description: 'Filter by material type',
    required: false,
    enum: MaterialType,
  })
  @ApiQuery({
    name: 'scriptId',
    description:
      'Narrow results to a specific script within the project (UUID)',
    required: false,
    type: 'string',
  })
  @ApiOkResponse({
    description:
      'All materials in the project. Each item includes `scriptId` so the client can group by script. Returns an empty array if none exist.',
    schema: {
      example: {
        success: true,
        message: 'Materials retrieved successfully',
        data: [
          {
            ...MATERIAL_EXAMPLE,
            type: 'link',
            title: 'Character Reference Sheet',
            url: 'https://example.com/reference',
          },
          {
            ...MATERIAL_EXAMPLE,
            id: '523e4567-e89b-12d3-a456-426614174004',
            scriptId: '224e4567-e89b-12d3-a456-426614174001',
            type: 'file',
            title: 'Scene Blocking Notes',
            url: null,
            fileKey: 'uploads/def456/blocking.pdf',
            fileUrl:
              'https://s3.amazonaws.com/bucket/uploads/def456/blocking.pdf',
            fileName: 'blocking.pdf',
            fileSizeBytes: 512000,
            mimeType: 'application/pdf',
          },
        ],
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid UUID format for projectId',
    schema: BAD_REQUEST_SCHEMA(['Validation failed (uuid is expected)']),
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: UNAUTHORIZED_SCHEMA,
  })
  @ApiNotFoundResponse({
    description:
      'Project not found or does not belong to the authenticated user',
    schema: NOT_FOUND_SCHEMA('Project'),
  })
  async getMaterialsByProject(
    @Req() req: any,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('type') type?: string,
    @Query('scriptId') scriptId?: string,
  ) {
    const userId = req.user?.id;
    if (!userId)
      throw new UnauthorizedException('User ID not found in request');
    return this.materialsService.getMaterialsByProject(
      userId,
      projectId,
      type,
      scriptId,
    );
  }

  @Delete('materials/:id')
  @ApiOperation({
    summary: 'Delete a material',
    description:
      'Soft-deletes a material. Only the actor who created the material can delete it.',
  })
  @ApiParam({
    name: 'id',
    description: 'UUID of the material to delete',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Material deleted successfully',
    schema: {
      example: { success: true, message: 'Material deleted successfully' },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid UUID format for material id',
    schema: BAD_REQUEST_SCHEMA(['Validation failed (uuid is expected)']),
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: UNAUTHORIZED_SCHEMA,
  })
  @ApiNotFoundResponse({
    description:
      'Material not found or does not belong to the authenticated user',
    schema: NOT_FOUND_SCHEMA('Material'),
  })
  async deleteMaterial(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = req.user?.id;
    if (!userId)
      throw new UnauthorizedException('User ID not found in request');
    return this.materialsService.deleteMaterial(userId, id);
  }
}
