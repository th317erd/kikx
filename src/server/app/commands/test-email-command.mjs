import Path from 'node:path';
import FileSystem from 'node:fs';
import { CLI } from 'mythix';

import { fileURLToPath }  from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = Path.dirname(__filename);

const { CommandBase } = CLI;

export class TestEmailCommand extends CommandBase {
  static getCommandName() {
    return 'test-email';
  }

  static commandArguments() {
    return {
      help: {
        /* eslint-disable key-spacing */
        '@usage': 'mythix-cli test-email [options]',
        '@title': 'Test email rendering',
        '-t={template name} | -t {template name} | --template={template name} | --template {template name}': 'Email template name to render',
      },
      runner: ({ $, Types, store }) => {
        $('--template', Types.STRING(), { name: 'template' })
          || $('-t', Types.STRING(), { name: 'template' })
          || store({ template: 'auth/signIn' });

        return true;
      },
    };
  }

  async execute(options) {
    let templateName = options.template;
    let app = this.getApplication();
    let {
      User,
      Organization,
    } = app.getModels();

    let organization = await Organization.first();
    if (!organization) {
      organization = new Organization({ name: 'Test Organization' });
      await organization.save();
    }

    let targetUser = await User.where.email.EQ('test@example.com').first();
    if (!targetUser) {
      targetUser = new User({
        email:      'test@example.com',
        firstName:  'Bob',
        lastName:   'Brown',
      });

      await targetUser.save();
    }

    let initiatingUser = await User.where.email.EQ('test2@example.com').first();
    if (!initiatingUser) {
      initiatingUser = new User({
        email:      'test2@example.com',
        firstName:  'John',
        lastName:   'Smith',
      });

      await initiatingUser.save();
    }

    let outputRootPath = Path.resolve(__dirname, '..', '..', 'test');
    FileSystem.mkdirSync(outputRootPath, { recursive: true });

    let outputPath = Path.join(outputRootPath, `${templateName.replace(/\W/g, '-')}.html`);
    let data = {};

    if ((/^(auth\/signIn|auth\/signUp)$/).test(templateName)) {
      data = {
        to:             targetUser.email,
        magicLinkURL:   'https://www.google.com/',
        initiatingUser: targetUser,
        targetUser:     targetUser,
        organization,
      };
    } else if ((/^(org\/userRolesUpdated)$/).test(templateName)) {
      data = {
        to:             targetUser.email,
        magicLinkURL:   'https://www.google.com/',
        initiatingUser: initiatingUser,
        targetUser:     targetUser,
        addedRoles:     [ 'member' ],
        removedRoles:   [ 'masteradmin' ],
        organization,
      };
    } else {
      console.error(`Unknown email template "${templateName}"`);
      return;
    }

    let { body } = await targetUser.renderEmail(templateName, data);
    FileSystem.writeFileSync(outputPath, body, 'utf8');
  }
}
