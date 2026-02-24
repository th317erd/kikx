/* eslint-disable max-classes-per-file */

import { SQLiteConnection } from 'mythix-orm-sqlite';
// import { PostgreSQLConnection } from 'mythix-orm-postgresql';
import { Application } from '../../app/application.mjs';
import { createFactories } from './factories/index.mjs';

import {
  TestUtils,
} from 'mythix';

import {
  MailerModule,
  AWSModule,
} from '../../app/modules/index.mjs';

// Here we extend the mailer module for unit tests
// to disable the sending of any emails while unit
// testing
class TestMailerModule extends MailerModule {
  async start() {
    // NO OP
  }

  async deliverEmail() {
    // NO OP... don't send emails in tests
  }
}

// Here we extend the aws module for unit tests
// to disable the uploading of files to S3
// while unit testing
class TestAWSModule extends AWSModule {
  async start() {
    // NO OP
  }

  async uploadToS3(options) {
    // Pretend we uploaded and return the URL
    return `https://hero.com/${options.folder}/${options.fileName}`;
  }
}

// This is to swap out the mailer module with
// our unit test specific mailer module above
class _TestApplicationShim extends Application {
  constructor(_opts) {
    let opts = _opts || {};
    super({
      ...opts,
      bindToProcessSignals: false,
    });
  }

  static getDefaultModules() {
    let defaultModules = Application.getDefaultModules();

    defaultModules = Application.replaceModule(defaultModules, MailerModule, TestMailerModule);
    defaultModules = Application.replaceModule(defaultModules, AWSModule, TestAWSModule);

    return defaultModules;
  }

  // eslint-disable-next-line no-unused-vars
  async createDatabaseConnection(databaseConfig) {
    let connection = new SQLiteConnection({
      bindModels:                 false,
      emulateBigIntAutoIncrement: true,
    });
    // let connection = new PostgreSQLConnection(databaseConfig);

    await connection.start();
    return connection;
  }
}

// Create our test application using mythix
// test utilities
const TestApplication = TestUtils.createTestApplication(_TestApplicationShim);

// Instantiate and configure our test application
async function createTestApplication() {
  let app = new TestApplication({
    logger: {
      level: (process.env.MYTHIX_LOG_LEVEL) ? parseInt(process.env.MYTHIX_LOG_LEVEL, 10) : 0,
    },
  });

  app.setConfig({
    application: {
      test: {
        salt:               'eyJzZWNyZXRLZXkiOiJLdzFVN0RlNU5XZHJQTEhGV20xZEVYdFJubFRHWlFGLUZHWVk1bExPYnk0PSIsIml2IjoiY1k1ZEJKTk5QSjBxNlQ2UTJXUk5oZz09In0=',
        domain:             'test.hero.com',
        mfaPageURL:         'https://test.hero.com/pages/mfa',
        afterLoginPageURL:  'https://test.hero.com/pages/home',
        magicLinkURL:       'https://test.hero.com/api/v1/auth/login',
      },
      smtp: {
        domain: 'example.com',
        apiKey: 'test',
      },
    },
  });

  await app.start();

  app.setDefaultHeaders({
    'Content-Type': 'application/json',
  });

  return app;
}

// Helpful patterns commonly used in unit tests
const PREFIXED_XID_REGEXP     = /^[A-Z]{3}_[0-9abcdefghjkmnpqrstvwxyz]{20}$/;
const URL_SAFE_BASE64_REGEXP  = /^[A-Za-z0-9_=-]+$/;
const SHA512_REGEXP           = /[a-f0-9]{64}/;

const _it = it;
const _fit = fit;

function createIT(func, getConnection) {
  return function it(desc, runner) {
    return func.call(this, desc, async () => {
      await getConnection().createContext(runner);
    });
  };
}

function createFIT(func, getConnection) {
  return function fit(desc, runner) {
    return func.call(this, desc, async () => {
      await getConnection().createContext(runner);
    });
  };
}

function createRunners(getConnection) {
  return {
    it:   createIT(_it, getConnection),
    fit:  createFIT(_fit, getConnection),
  };
}

export {
  createFactories,
  createTestApplication,
  createRunners,
  SHA512_REGEXP,
  TestApplication,
  PREFIXED_XID_REGEXP,
  URL_SAFE_BASE64_REGEXP,
};
