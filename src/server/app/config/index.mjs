import Nife from 'nife';
import database from './db-config.mjs';
import sensitive from './sensitive.mjs';
import { Logger } from 'mythix';

const APP_CONFIG = Nife.extend(true, {
  environment:  process.env.NODE_ENV || 'development',
  logger:       {
    level: Logger.LEVEL_DEBUG,
  },
  httpServer: {
    host: 'localhost',
    port: 8089,
  },
  database,
  application: {
    development: {
      domain:             'wyatt-desktop.mythix.info',
      appRootURL:         'https://wyatt-desktop.mythix.info/hero/',
      mfaPageURL:         'https://wyatt-desktop.mythix.info/hero/pages/mfa',
      afterLoginPageURL:  'https://wyatt-desktop.mythix.info/hero/pages/home',
      magicLinkURL:       'https://wyatt-desktop.mythix.info/hero/login',
      getHelpURL:         'https://gethelp.com/',
    },
  },
}, sensitive);

export default APP_CONFIG;
