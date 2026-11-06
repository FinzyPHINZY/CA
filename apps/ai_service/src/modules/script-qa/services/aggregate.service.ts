import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { RouterResult } from './query-router.service';
import {
  AGGREGATE_TEMPLATES,
  AggregateTemplate,
} from '../sql/aggregate-templates';

export interface AggregateResult {
  templateName: string;
  answer: string;
  raw: any[];
}

@Injectable()
export class AggregateService {
  private readonly logger = new Logger(AggregateService.name);

  constructor(private readonly dataSource: DataSource) {}

  matchTemplate(
    routerResult: RouterResult,
  ): AggregateTemplate | null {
    const question = routerResult.rewrittenQuestion;

    for (const template of AGGREGATE_TEMPLATES) {
      for (const pattern of template.matchPatterns) {
        if (pattern.test(question)) {
          return template;
        }
      }
    }

    this.logger.debug(
      `No aggregate template matched for: "${question.substring(0, 80)}"`,
    );
    return null;
  }

  async execute(
    scriptId: string,
    template: AggregateTemplate,
    routerResult: RouterResult,
  ): Promise<AggregateResult> {
    const extractedParams = template.paramExtractor(routerResult.filters);
    const sqlParams = [scriptId, ...extractedParams];

    this.logger.debug(
      `Executing ${template.name} with params: ${JSON.stringify(sqlParams)}`,
    );

    const rows = await this.dataSource.query(template.sql, sqlParams);
    const answer = template.formatFn(rows, extractedParams);

    return {
      templateName: template.name,
      answer,
      raw: rows,
    };
  }
}
