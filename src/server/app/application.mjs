import {
  Application as MythixApplication,
} from 'mythix';

import Nife                    from 'nife';
import { getRoutes }           from './routes/index.mjs';
import cookieParser            from 'cookie-parser';
import { SQLiteConnection }    from 'mythix-orm-sqlite';
import * as Controllers        from './controllers/index.mjs';
import * as Models             from './models/index.mjs';
import { COMMANDS }            from './commands/index.mjs';

import APP_CONFIG from './config/index.mjs';

export class Application extends MythixApplication {
  static getName() {
    return 'kikx';
  }

  static getCommandList() {
    return {
      ...super.getCommandList(),
      ...COMMANDS,
    };
  }

  constructor(_options) {
    const {
      environment,
      database,
      logger,
    } = APP_CONFIG;

    let options = Nife.extend(true, {
      config:      APP_CONFIG,
      httpServer:  {
        middleware: [
          cookieParser(),
        ],
      },
      environment,
      database,
      logger,
    }, (_options || {}));

    super(options);
  }

  getRoutes(...args) {
    return getRoutes.apply(this, args);
  }

  getAppControllerClasses() {
    return {
      ...super.getAppControllerClasses(),
      ...Controllers,
    };
  }

  getAppModelClasses(connection) {
    return this.bindModels(connection, {
      ...super.getAppModelClasses(connection),
      ...Models,
    });
  }

  getSalt() {
    if (this._cachedSalt)
      return this._cachedSalt;

    let salt = this.getConfigValue('application.{environment}.salt');
    if (!salt)
      throw new Error('Application "salt" is empty.');

    Object.defineProperties(this, {
      '_cachedSalt': {
        writable:     false,
        enumerable:   false,
        configurable: false,
        value:        salt,
      },
    });

    return salt;
  }

  getAuthTokenCookieName() {
    return `${this.getApplicationName().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '')}-auth-token`;
  }

  async createDatabaseConnection(dbConfig) {
    let connection = new SQLiteConnection(dbConfig);

    await connection.start();

    return connection;
  }

  async start() {
    await super.start();

    let connection = this.getConnection();
    let models     = this.getModels();

    for (let Model of Object.values(models)) {
      if (typeof Model.getTableName === 'function')
        await connection.createTable(Model);
    }
  }

  async userLogin(email) {
    let {
      User,
    } = this.getModels();

    let user = await User.where.email.EQ(email).first();
    if (!user)
      throw new Error(`User "${email}" not found`);

    let { sessionToken } = await user.generateSessionToken({
      skipMFA:      true,
      isSeedToken:  false,
    });

    console.log(`https://${this.getConfigValue('application.{environment}.domain', 'wyatt-desktop.mythix.info')}/kikx/?page=login&magicToken=${sessionToken}`);
  }
}
