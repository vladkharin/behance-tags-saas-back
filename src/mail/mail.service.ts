import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly isConfigured: boolean = false;

  constructor(private configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT');
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');
    const secure = this.configService.get<string>('SMTP_SECURE') === 'true' || Number(port) === 465;

    if (host && user && pass) {
      try {
        const isGmail = host === 'smtp.gmail.com' || (user && user.includes('@gmail.com'));

        if (isGmail) {
          this.transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
              user,
              pass,
            },
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            socketTimeout: 15000,
          });
          this.logger.log(`[MailService] Gmail SMTP транспорт инициализирован (service: gmail) для ${user}`);
        } else {
          this.transporter = nodemailer.createTransport({
            host,
            port: Number(port) || 465,
            secure,
            auth: {
              user,
              pass,
            },
            tls: {
              rejectUnauthorized: false,
            },
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            socketTimeout: 15000,
          });
          this.logger.log(`[MailService] SMTP транспорт инициализирован: ${host}:${port} (${user})`);
        }
        this.isConfigured = true;
      } catch (err) {
        this.logger.error('[MailService] Ошибка настройки SMTP транспорта:', err);
      }
    } else {
      this.logger.warn('[MailService] SMTP не настроен в .env (коды верификации будут логироваться в консоль сервера)');
    }
  }

  async sendVerificationCode(to: string, code: string, userName?: string): Promise<boolean> {
    const from = this.configService.get<string>('SMTP_FROM') || 'BeRanked <dom.craft.digital@gmail.com>';
    const greeting = userName ? `Здравствуйте, ${userName}!` : 'Здравствуйте!';

    // Красивый адаптивный HTML шаблон письма
    const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Подтверждение почты BeRanked</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b0b0e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f4f4f5;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #0b0b0e; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="520" border="0" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color: #141419; border: 1px solid #27272a; border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
          <!-- Header Banner -->
          <tr>
            <td style="padding: 32px 32px 20px 32px; text-align: center; border-bottom: 1px solid #27272a; background: linear-gradient(180deg, rgba(0,87,255,0.15) 0%, rgba(20,20,25,0) 100%);">
              <div style="display: inline-block; padding: 8px 16px; background-color: #0057ff; border-radius: 12px; color: #ffffff; font-weight: 900; font-size: 16px; letter-spacing: -0.5px;">
                BeRanked
              </div>
              <h1 style="margin: 20px 0 6px 0; font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">Подтверждение почты</h1>
              <p style="margin: 0; font-size: 13px; color: #a1a1aa;">Аналитика и мониторинг позиций тегов Behance</p>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding: 32px;">
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.5; color: #e4e4e7;">
                ${greeting}
              </p>
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.5; color: #a1a1aa;">
                Спасибо за регистрацию на платформе BeRanked. Чтобы завершить создание аккаунта и защитить ваши данные, введите этот 6-значный проверочный код:
              </p>

              <!-- OTP Code Box -->
              <div style="background-color: #09090b; border: 2px solid #0057ff; border-radius: 14px; padding: 20px; text-align: center; margin: 24px 0;">
                <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 36px; font-weight: 900; letter-spacing: 10px; color: #ffffff; text-shadow: 0 0 20px rgba(0,87,255,0.5);">
                  ${code}
                </span>
              </div>

              <div style="background-color: rgba(234, 179, 8, 0.08); border-left: 3px solid #eab308; padding: 12px 16px; border-radius: 6px; margin: 24px 0 0 0;">
                <p style="margin: 0; font-size: 12px; color: #fef08a; line-height: 1.4;">
                  ⏳ <strong>Важно:</strong> Код действителен в течение <strong>15 минут</strong>. Если вы не регистрировались на сайте, просто проигнорируйте это письмо.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #0e0e12; border-top: 1px solid #27272a; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #71717a;">
                © ${new Date().getFullYear()} BeRanked SaaS • Все права защищены.<br>
                Письмо отправлено автоматически, отвечать на него не нужно.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    const text = `${greeting}\n\nВаш 6-значный код подтверждения BeRanked: ${code}\n\nКод действителен 15 минут. Если вы не регистрировались, проигнорируйте это сообщение.`;

    // Логируем в консоль для разработки
    this.logger.log(`\n======================================================\n📧 [EMAIL VERIFICATION CODE]\n👤 To: ${to}\n🔢 CODE: ${code}\n⏳ Valid for 15 minutes\n======================================================\n`);

    const resendApiKey = this.configService.get<string>('RESEND_API_KEY');
    let resendSent = false;

    if (resendApiKey) {
      const resendFrom = this.configService.get<string>('RESEND_FROM') || 'BeRanked <onboarding@resend.dev>';
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: resendFrom,
            to: [to],
            subject: `Код подтверждения: ${code} — BeRanked`,
            html,
            text,
          }),
        });

        if (res.ok) {
          this.logger.log(`[MailService] Письмо с кодом ${code} успешно отправлено через Resend HTTPS API на ${to}`);
          resendSent = true;
        } else {
          const errData = await res.json().catch(() => ({}));
          this.logger.error(`[MailService] Ошибка ответа Resend API:`, errData);
        }
      } catch (err) {
        this.logger.error(`[MailService] Ошибка сетевого запроса Resend API:`, err);
      }
    }

    if (resendSent) {
      return true;
    }

    if (this.isConfigured && this.transporter) {
      try {
        await this.transporter.sendMail({
          from,
          to,
          subject: `Код подтверждения: ${code} — BeRanked`,
          text,
          html,
        });
        this.logger.log(`[MailService] Письмо с кодом ${code} успешно отправлено на ${to} через SMTP`);
        return true;
      } catch (error) {
        this.logger.error(`[MailService] Ошибка отправки письма через SMTP на ${to}:`, error);
        return false;
      }
    }

    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    if (isProduction) {
      this.logger.error(`[MailService] Не удалось отправить письмо на ${to}: все почтовые сервисы дали сбой или не настроены`);
      return false;
    }

    this.logger.warn(`[MailService] Почта не была отправлена (режим разработки), флоу продолжается успешно, так как код выведен в консоль.`);
    return true;
  }
}
