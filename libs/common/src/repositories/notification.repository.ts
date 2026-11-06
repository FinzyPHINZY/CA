import { DataSource } from 'typeorm';
import { BaseRepository } from './base.repository';
import { Notification } from '../entities/notification.entity';
import { Injectable } from '@nestjs/common';

@Injectable()
export class NotificationRepository extends BaseRepository<Notification> {
  constructor(dataSource: DataSource) {
    super(Notification, dataSource.manager);
  }

  async createNotification(data: Partial<Notification>): Promise<Notification> {
    return this.createEntity(data);
  }

  async findByRecipientUserId(
    recipientUserId: string,
  ): Promise<Notification[]> {
    return this.find({
      where: { recipientUserId },
      order: { createdAt: 'DESC' },
    });
  }

  async findUnreadByRecipientUserId(
    recipientUserId: string,
  ): Promise<Notification[]> {
    return this.find({
      where: { recipientUserId, read: false } as any,
      order: { createdAt: 'DESC' },
    });
  }

  async findByNotificationType(
    recipientUserId: string,
    notificationType: string,
  ): Promise<Notification[]> {
    return this.find({
      where: { recipientUserId, notificationType } as any,
      order: { createdAt: 'DESC' },
    });
  }

  async findByTaskId(taskId: string): Promise<Notification[]> {
    return this.find({
      where: { taskId } as any,
      order: { createdAt: 'DESC' },
    });
  }

  async markReadById(id: string): Promise<void> {
    await this.updateById(id, { read: true } as any);
  }

  async markAllReadForRecipient(recipientUserId: string): Promise<void> {
    await this.updateMany(
      { recipientUserId, read: false } as any,
      {
        read: true,
      } as any,
    );
  }

  async deleteById(id: string): Promise<void> {
    await this.deleteMany({ id } as any);
  }
}
