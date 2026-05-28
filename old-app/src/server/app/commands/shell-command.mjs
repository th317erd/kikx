import { CLI } from 'mythix';
import Utils from '../utils/index.mjs';
import { seedDB } from '../seeders/initial-db-seeder.mjs';

const {
  Commands: {
    ShellCommand: _ShellCommand,
  },
} = CLI;

export class ShellCommand extends _ShellCommand {
  static getCommandName() {
    return 'shell';
  }

  onStart(interactiveShell) {
    var context = interactiveShell.context;

    // Inject into "context" to expose globals in the shell
    // or customize your shell startup however you desire here
    Object.assign(context, {
      seedDB: seedDB.bind(context.application, context.application),
      Utils,
    });
  }
}
