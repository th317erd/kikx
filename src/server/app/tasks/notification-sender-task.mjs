import { DateTime } from 'luxon';
import { TaskBase } from 'mythix';

const DEFAULT_WORKER_COUNT              = 4;
const DEFAULT_WORKER_FREQUENCY_SECONDS  = 5;

export class NotificationSenderTask extends TaskBase {
  static getWorkerCount() {
    return DEFAULT_WORKER_COUNT;
  }

  static nextRun() {
    return DateTime.now().plus({ seconds: DEFAULT_WORKER_FREQUENCY_SECONDS });
  }

  async execute() {
    let { Notification } = this.getModels();

    await Notification.getBatchToProcess(this.getRunID(), async (notification, user) => {
      let application = this.getApplication();

      if (notification.type === 'email') {
        let mailer = application.getMailer();
        await mailer.sendEmail({
          to:       user.email,
          subject:  notification.subject,
          message:  notification.content,
        });
      }
    });
  }
}
