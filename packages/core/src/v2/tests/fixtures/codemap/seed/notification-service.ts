/**
 * CodeMap 性能基准测试种子文件 - 通知服务
 */

export class NotificationService {
  sendEmail(to: string, subject: string, body: string): void {
    console.log(`[Email] To: ${to}, Subject: ${subject}`);
    console.log(`Body: ${body}`);
  }

  sendSMS(to: string, message: string): void {
    console.log(`[SMS] To: ${to}: ${message}`);
  }

  sendPushNotification(userId: string, title: string, body: string): void {
    console.log(`[Push] User: ${userId}, Title: ${title}, Body: ${body}`);
  }
}

export type NotificationType = "email" | "sms" | "push";

export interface NotificationPayload {
  type: NotificationType;
  to: string;
  title?: string;
  body: string;
}
