/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */
import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import * as Handlebars from 'handlebars';
import { TemplateDelegate } from 'handlebars';
import { join } from 'path';

export interface TemplateData {
  [key: string]: any;
}

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class EmailTemplateService {
  private readonly logger = new Logger(EmailTemplateService.name);
  private readonly templatesPath: string;
  private readonly templateCache: Map<string, TemplateDelegate> = new Map();

  constructor() {
    // Templates directory - try multiple paths to work in dev, Docker, and production
    const possiblePaths = [
      // Development: source templates
      join(
        process.cwd(),
        'apps',
        'notifications',
        'src',
        'notifications',
        'templates',
      ),
      // Production/Docker: templates copied to root
      join(process.cwd(), 'templates'),
      // Alternative: templates in dist
      join(process.cwd(), 'dist', 'apps', 'notifications', 'templates'),
      // Docker volume mount (if templates are in source)
      join(
        '/usr/src/app',
        'apps',
        'notifications',
        'src',
        'notifications',
        'templates',
      ),
    ];

    // Find the first path that exists
    let foundPath: string | null = null;
    for (const path of possiblePaths) {
      if (existsSync(path)) {
        foundPath = path;
        this.logger.log(`Using templates from: ${path}`);
        break;
      }
    }

    // Default to development path if none found
    this.templatesPath = foundPath || possiblePaths[0];
    if (!foundPath) {
      this.logger.warn(
        `Templates directory not found, using default: ${this.templatesPath}`,
      );
    }

    // Register Handlebars helpers
    this.registerHelpers();
  }

  /**
   * Load and render an email template using Handlebars
   * @param templateName Name of the template (without extension)
   * @param data Data to inject into the template
   * @returns Rendered template with subject, html, and text
   */
  async renderTemplate(
    templateName: string,
    data: TemplateData,
  ): Promise<RenderedTemplate> {
    try {
      this.logger.log(
        `Attempting to render template "${templateName}" from path: ${this.templatesPath}`,
      );

      // Load and compile templates
      const subjectTemplate = this.getCompiledTemplate(templateName, 'subject');
      const htmlTemplate = this.getCompiledTemplate(templateName, 'html');
      const textTemplate = this.getCompiledTemplate(templateName, 'txt');

      // Render templates with data
      const subject = subjectTemplate(data);
      const html = htmlTemplate(data);
      const text = textTemplate(data);

      this.logger.log(
        `Successfully rendered template "${templateName}". Subject length: ${subject.length}, HTML length: ${html.length}, Text length: ${text.length}`,
      );

      return { subject, html, text };
    } catch (error) {
      this.logger.error(
        `Failed to render template ${templateName}: ${error.message}`,
        error.stack,
      );
      this.logger.error(`Template path being used: ${this.templatesPath}`);
      throw error;
    }
  }

  /**
   * Check if a template exists
   */
  templateExists(templateName: string): boolean {
    const subjectPath = this.getTemplatePath(templateName, 'subject');
    return existsSync(subjectPath);
  }

  /**
   * Load a template file
   */
  private loadTemplate(templateName: string, extension: string): string {
    const templatePath = this.getTemplatePath(templateName, extension);

    if (!existsSync(templatePath)) {
      throw new Error(
        `Template file not found: ${templatePath}. Template: ${templateName}.${extension}`,
      );
    }

    try {
      return readFileSync(templatePath, 'utf-8');
    } catch (error) {
      throw new Error(
        `Failed to read template file ${templatePath}: ${error.message}`,
      );
    }
  }

  /**
   * Get the full path to a template file
   */
  private getTemplatePath(templateName: string, extension: string): string {
    return join(this.templatesPath, `${templateName}.${extension}`);
  }

  /**
   * Get compiled Handlebars template (with caching)
   */
  private getCompiledTemplate(
    templateName: string,
    extension: string,
  ): TemplateDelegate {
    const cacheKey = `${templateName}.${extension}`;

    // Return cached template if available
    if (this.templateCache.has(cacheKey)) {
      return this.templateCache.get(cacheKey)!;
    }

    // Load and compile template
    const templateSource = this.loadTemplate(templateName, extension);
    const compiledTemplate = Handlebars.compile(templateSource);

    // Cache the compiled template
    this.templateCache.set(cacheKey, compiledTemplate);

    return compiledTemplate;
  }

  /**
   * Register custom Handlebars helpers
   */
  private registerHelpers(): void {
    // Helper for formatting dates
    Handlebars.registerHelper(
      'formatDate',
      (date: Date | string, format?: string) => {
        const d = typeof date === 'string' ? new Date(date) : date;
        if (!d || Number.isNaN(d.getTime())) {
          return '';
        }
        // Simple date formatting (can be enhanced with date-fns or moment)
        return d.toLocaleDateString();
      },
    );

    // Helper for uppercase
    Handlebars.registerHelper('uppercase', (str: string) => {
      return typeof str === 'string' ? str.toUpperCase() : '';
    });

    // Helper for lowercase
    Handlebars.registerHelper('lowercase', (str: string) => {
      return typeof str === 'string' ? str.toLowerCase() : '';
    });

    // Helper for equality check
    Handlebars.registerHelper('eq', (a: any, b: any) => {
      return a === b;
    });

    // Helper for not equal
    Handlebars.registerHelper('ne', (a: any, b: any) => {
      return a !== b;
    });
  }
}
