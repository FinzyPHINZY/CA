import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Notification } from '@app/common';
import { SendNotificationDto } from './dto/send-notification.dto';
import { User } from '@app/common';
import { EmailTemplateService } from './services/email-template.service';
import { EmailService } from './services/email.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly templateService: EmailTemplateService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async sendBookingConfirmedEmails(payload: {
    bookingId: string;
    actorUserId: string;
    readerUserId: string;
    sessionStartUtc: string;
    sessionEndUtc: string;
    sessionDurationMinutes: number;
    priceCents: number;
    currency: string;
    actorIcsContent?: string;
    readerIcsContent?: string;
  }): Promise<void> {
    const userRepo = this.dataSource.getRepository(User);
    const [actor, reader] = await Promise.all([
      userRepo.findOne({ where: { id: payload.actorUserId } }),
      userRepo.findOne({ where: { id: payload.readerUserId } }),
    ]);

    const sessionDate = new Date(payload.sessionStartUtc).toLocaleString(
      'en-US',
      {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'UTC',
      },
    );
    const amountDollars = (payload.priceCents / 100).toFixed(2);

    const recipients = [
      { user: actor, role: 'Actor', icsContent: payload.actorIcsContent },
      { user: reader, role: 'Reader', icsContent: payload.readerIcsContent },
    ];

    for (const { user, role, icsContent } of recipients) {
      if (!user?.email) continue;
      try {
        await this.emailService.sendEmail({
          to: user.email,
          subject: 'Your CueActor session is confirmed',
          html: `
            <h2>Session Confirmed</h2>
            <p>Hi ${user.fullName || user.email},</p>
            <p>Your CueActor script reading session has been confirmed.</p>
            <ul>
              <li><strong>Date:</strong> ${sessionDate} UTC</li>
              <li><strong>Duration:</strong> ${payload.sessionDurationMinutes} minutes</li>
              <li><strong>Your role:</strong> ${role}</li>
              <li><strong>Amount:</strong> $${amountDollars} ${payload.currency.toUpperCase()}</li>
            </ul>
            <p>The calendar invite is attached. Open it to add this session to your calendar.</p>
            <p>You can also subscribe to your full CueActor calendar feed from your account settings.</p>
          `,
          attachments: icsContent
            ? [
                {
                  filename: 'cueactor-session.ics',
                  content: icsContent,
                  contentType: 'text/calendar; method=REQUEST; charset=utf-8',
                },
              ]
            : [],
        });
        this.logger.log(
          `Booking confirmed email sent to ${user.email} (${role})`,
        );
      } catch (err: any) {
        this.logger.error(
          `Failed to send booking confirmed email to ${user.email}: ${err.message}`,
        );
      }
    }
  }

  async send(dto: SendNotificationDto) {
    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const notifRepo = manager.getRepository(Notification);

      const recipient = await userRepo.findOne({
        where: { id: dto.recipientUserId },
      });
      if (!recipient) {
        this.logger.warn(`Recipient not found: ${dto.recipientUserId}`);
        return { delivered: [], stored: false };
      }

      const delivered: string[] = [];

      if (dto.channels.includes('in_app')) {
        const notification = notifRepo.create({
          recipientUserId: dto.recipientUserId,
          title: dto.title,
          body: dto.body,
        });
        await notifRepo.save(notification);
        delivered.push('in_app');
      }

      if (dto.channels.includes('email')) {
        const to = dto.email || recipient.email;
        if (to) {
          try {
            // Prepare template data
            const templateData = this.prepareTemplateData(
              dto,
              recipient,
              dto.data || {},
            );

            // Use template if provided, otherwise use default notification template
            const templateName = dto.template || 'notification';

            let emailSubject = dto.title;
            let emailHtml = dto.body;
            let emailText = dto.body;

            // Render template if it exists
            if (this.templateService.templateExists(templateName)) {
              try {
                this.logger.log(
                  `Rendering email template "${templateName}" with data: ${JSON.stringify(templateData)}`,
                );
                const rendered = await this.templateService.renderTemplate(
                  templateName,
                  templateData,
                );
                emailSubject = rendered.subject;
                emailHtml = rendered.html;
                emailText = rendered.text;
                this.logger.log(
                  `Template "${templateName}" rendered successfully. Subject: ${emailSubject}`,
                );
              } catch (templateError) {
                this.logger.error(
                  `Failed to render template "${templateName}": ${templateError?.message || JSON.stringify(templateError)}`,
                  templateError?.stack,
                );
                // If template rendering fails, we should still try to send with fallback
                // but log a warning
                this.logger.warn(
                  `Using fallback email content due to template rendering failure`,
                );
              }
            } else if (dto.template) {
              this.logger.warn(
                `Template "${dto.template}" not found, using default notification template`,
              );
            }

            // Send email using nodemailer
            await this.emailService.sendEmail({
              to,
              subject: emailSubject,
              html: emailHtml,
              text: emailText,
            });

            this.logger.log(
              `Email sent to ${to} using template "${templateName}": ${emailSubject}`,
            );

            delivered.push('email');
          } catch (error) {
            this.logger.error(
              `Failed to send email to ${to}: ${error.message}`,
              error.stack,
            );
          }
        } else {
          this.logger.warn(
            `No email available for user ${dto.recipientUserId}`,
          );
        }
      }

      return { delivered, stored: delivered.includes('in_app') };
    });
  }

  /**
   * Prepare template data by merging DTO data with recipient info and defaults
   */
  private prepareTemplateData(
    dto: SendNotificationDto,
    recipient: User,
    customData: Record<string, any>,
  ): Record<string, any> {
    // Get app name from config, custom data, or default
    const appName =
      customData.appName ||
      this.configService.get<string>('APP_NAME', 'ACR App');

    // Determine userName: prefer customData.name, then recipient.fullName, then recipient.email, then 'User'
    const userName =
      customData.name || recipient.fullName || recipient.email || 'User';

    return {
      // User information
      userName,
      userEmail: recipient.email,
      userId: recipient.id,

      // Notification content
      title: dto.title,
      body: dto.body,

      // App information
      appName,

      // Custom data from DTO (overrides defaults)
      ...customData,
    };
  }
}
