import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({
    description: 'HTTP status code',
    example: 400,
    type: Number,
  })
  statusCode: number;

  @ApiProperty({
    description: 'Error message or array of error messages',
    example: 'Invalid file or missing required fields',
    oneOf: [
      { type: 'string' },
      {
        type: 'array',
        items: { type: 'string' },
      },
    ],
  })
  message: string | string[];

  @ApiProperty({
    description: 'Error type',
    example: 'Bad Request',
    required: false,
  })
  error?: string;
}

export class NotFoundErrorResponseDto extends ErrorResponseDto {
  @ApiProperty({
    description: 'HTTP status code',
    example: 404,
    type: Number,
  })
  statusCode: 404;

  @ApiProperty({
    description: 'Error message',
    example: 'File with key documents/1704067200000-document.pdf not found',
  })
  message: string;

  @ApiProperty({
    description: 'Error type',
    example: 'Not Found',
  })
  error: 'Not Found';
}

export class UnauthorizedErrorResponseDto extends ErrorResponseDto {
  @ApiProperty({
    description: 'HTTP status code',
    example: 401,
    type: Number,
  })
  statusCode: 401;

  @ApiProperty({
    description: 'Error message',
    example: 'Invalid or missing authentication token',
  })
  message: string;

  @ApiProperty({
    description: 'Error type',
    example: 'Unauthorized',
  })
  error: 'Unauthorized';
}

export class BadRequestErrorResponseDto extends ErrorResponseDto {
  @ApiProperty({
    description: 'HTTP status code',
    example: 400,
    type: Number,
  })
  statusCode: 400;

  @ApiProperty({
    description: 'Error message or array of error messages',
    example: [
      'File is required',
      'File size exceeds maximum allowed size of 50MB',
      'Invalid file type. Allowed types: image/*, video/*, audio/*, application/pdf',
    ],
    oneOf: [
      { type: 'string' },
      {
        type: 'array',
        items: { type: 'string' },
      },
    ],
  })
  message: string | string[];

  @ApiProperty({
    description: 'Error type',
    example: 'Bad Request',
  })
  error: 'Bad Request';
}
