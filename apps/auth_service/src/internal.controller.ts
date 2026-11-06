import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController, type OpenAPIObject } from '@nestjs/swagger';

@Controller('internal')
@ApiExcludeController()
export class InternalController {
  private openapiDocument: OpenAPIObject;

  setOpenapiDocument(document: OpenAPIObject) {
    this.openapiDocument = document;
  }

  @Get('openapi.json')
  getOpenApiDocument() {
    return this.openapiDocument;
  }
}
