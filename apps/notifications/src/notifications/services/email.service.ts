/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly configService: ConfigService) {
    this.initializeTransporter();
  }

  /**
   * Initialize nodemailer transporter based on configuration
   */
  private initializeTransporter(): void {
    // Support both SMTP_* and EMAIL_* variable names for flexibility
    const host =
      this.configService.get<string>('EMAIL_HOST') ||
      this.configService.get<string>('SMTP_HOST');
    const port =
      this.configService.get<number>('EMAIL_PORT') ||
      this.configService.get<number>('SMTP_PORT', 587);
    const secure =
      this.configService.get<boolean>('EMAIL_SECURE') ??
      this.configService.get<boolean>('SMTP_SECURE', false);
    const user =
      this.configService.get<string>('EMAIL_USER') ||
      this.configService.get<string>('SMTP_USER');
    const password =
      this.configService.get<string>('EMAIL_PASSWORD') ||
      this.configService.get<string>('SMTP_PASSWORD');
    const smtpService = this.configService.get<string>('SMTP_SERVICE');

    if (!host && !smtpService) {
      this.logger.error(
        'SMTP configuration is incomplete. Please set SMTP_HOST (or EMAIL_HOST) and SMTP_USER (or EMAIL_USER) and SMTP_PASSWORD (or EMAIL_PASSWORD), or use SMTP_SERVICE (e.g., "gmail").',
      );
      this.transporter = null;
      return;
    }

    if (smtpService && !user && !password) {
      // Some services like Gmail require auth even with service
      this.logger.warn(
        'SMTP_SERVICE is set but SMTP_USER/SMTP_PASSWORD are missing. Some services may require authentication.',
      );
    }

    try {
      const auth = user && password ? { user, pass: password } : undefined;

      // Build transporter config - service and host/port are mutually exclusive
      const transporterConfig: any = {
        ...(auth && { auth }),
        logger: process.env.NODE_ENV === 'development',
        debug: process.env.NODE_ENV === 'development',
      };

      if (smtpService) {
        // Use service (e.g., 'gmail', 'outlook') - service handles host/port automatically
        transporterConfig.service = smtpService;
      } else if (host) {
        // Use explicit host/port configuration
        transporterConfig.host = host;
        transporterConfig.port = port;
        transporterConfig.secure = secure; // true for 465, false for other ports
      }

      this.transporter = nodemailer.createTransport(transporterConfig);

      // Verify connection
      this.transporter.verify((error, _success) => {
        if (error) {
          this.logger.error(
            `SMTP connection verification failed: ${error.message}`,
            error.stack,
          );
          this.transporter = null; // Disable transporter if verification fails
        } else {
          this.logger.log(
            `Email transporter initialized successfully${host ? ` for ${host}:${port}` : ` using service: ${smtpService}`}`,
          );
        }
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to initialize email transporter: ${error?.message || JSON.stringify(error)}`,
        error?.stack,
      );
      this.transporter = null;
    }
  }

  /**
   * Send an email
   */
  async sendEmail(options: SendEmailOptions): Promise<void> {
    if (!this.transporter) {
      throw new Error(
        'Email transporter is not initialized. Check SMTP configuration (SMTP_HOST/SMTP_USER/SMTP_PASSWORD or SMTP_SERVICE).',
      );
    }

    const fromAddress =
      this.configService.get<string>('EMAIL_FROM_ADDRESS') ||
      this.configService.get<string>('EMAIL_FROM') ||
      this.configService.get<string>('SMTP_USER') ||
      this.configService.get<string>('EMAIL_USER', 'noreply@example.com');

    const fromName = this.configService.get<string>('EMAIL_FROM_NAME');

    const from =
      options.from || (fromName ? `${fromName} <${fromAddress}>` : fromAddress);

    const mailOptions = {
      from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || this.stripHtml(options.html),
      ...(options.replyTo && { replyTo: options.replyTo }),
      ...(options.attachments &&
        options.attachments.length > 0 && {
          attachments: options.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
          })),
        }),
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      this.logger.log(
        `Email sent successfully to ${options.to}. MessageId: ${info.messageId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send email to ${options.to}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Verify SMTP connection
   */
  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) {
      return false;
    }

    try {
      await this.transporter.verify();
      this.logger.log('SMTP connection verified successfully');
      return true;
    } catch (error) {
      this.logger.error(
        `SMTP connection verification failed: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Strip HTML tags from HTML content to create plain text fallback
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }
}
