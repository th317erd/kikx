import Nife           from 'nife';
import { ModuleBase } from 'mythix';

// Mythix uses a "module" system to extend its functionality.
// "modules" can be thought of as plugins for mythix.
// Modules have a common pattern of "start", and "stop",
// to start and stop the module. Mythix calls these methods
// directly upon app start and shutdown.
//
// This module enables email functionality for the application.
// For example, an email can be sent simply by
// fetching the module from the application, and interacting
// with it: await application.getMailer().sendEmail({ ... });
//
// Email sending is deliberately disabled in unit tests.

export class MailerModule extends ModuleBase {
  static getModuleName() {
    return 'MailerModule';
  }

  constructor(application) {
    super(application);

    Object.defineProperties(this, {
      'mailerConfig': {
        writable:     true,
        enumberable:  false,
        configurable: true,
        value:        null,
      },
      'client': {
        writable:     true,
        enumberable:  false,
        configurable: true,
        value:        null,
      },
    });

    // Inject methods into the application
    Object.defineProperties(application, {
      'getMailerConfig': {
        writable:     true,
        enumberable:  false,
        configurable: true,
        value:        this.getMailerConfig.bind(this),
      },
      'getMailer': {
        writable:     true,
        enumberable:  false,
        configurable: true,
        value:        () => this,
      },
    });
  }

  getMailerConfig() {
    if (this.mailerConfig)
      return this.mailerConfig;

    let app = this.getApplication();
    let mailerConfig = Nife.extend(true, {
      domain:   'mail.somedomain.com',
      username: 'api',
      key:      app.getConfigValue('application.{environment}.mailer.apiKey'),
    });

    return mailerConfig;
  }

  async start() {
    // let mailerConfig  = this.mailerConfig = this.getMailerConfig();
    // create your mail client here
    // let mailerLib     = new MyMailer();
    // let client        = this.client = mailerLib.client(mailerConfig);
  }

  async stop() {
    // Shutdown mailer
  }

  async deliverEmail(domain, options) {
    // send email through mailer library client (this.client)
    return await this.client.messages.create(domain, options);
  }

  async sendEmail(_opts) {
    let mailerConfig  = this.getMailerConfig();
    let opts          = _opts || {};
    let options       = {
      from:     opts.from || '"Hero" <noreply@hero.com>',
      to:       opts.to,
      subject:  opts.subject,
      html:     opts.message,
    };

    return await this.deliverEmail(mailerConfig.domain, options);
  }
}
