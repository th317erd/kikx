import Nife               from 'nife';
import { ControllerBase } from './controller-base.mjs';
import { Controllers }    from 'mythix';

const CACHE = {};

// This controller serves up the `client-interface.js`
// through the mythix API interface generator.
// It uses the routes defined in "routes.js"
// to generate this Javascript interface.

export class APIInterfaceController extends ControllerBase {
  async get({ query }) {
    const sendResponse = (content) => {
      this.setHeader('Content-Type', 'text/javascript; charset=UTF-8');
      return content;
    };

    let options = this.getParams({
      'domain':       (value) => value.trim(),
      'mode':         (value) => value.trim(),
      'environment':  (value) => value.trim(),
      'globalName':   (value) => value.trim(),
      'cacheKey':     (value) => value.trim(),
      'cache':        (value) => value.trim(),
      'type':         (value) => value.trim(),
    }, [ query ]);

    if (!options.mode)
      options.mode = 'production';

    if (options.globalName === 'none')
      options.globalName = null;
    else if (Nife.isEmpty(options.globalName))
      options.globalName = 'API';

    if (options.cache !== 'false') {
      if (Nife.isEmpty(options.cacheKey))
        options.cacheKey = `${options.environment}:${options.globalName}:${options.domain}:${options.mode}`;

      let cached = CACHE[options.cacheKey];
      if (!cached)
        cached = CACHE[options.cacheKey] = Controllers.generateClientAPIInterface(this.getApplication(), options);

      return sendResponse(cached);
    } else {
      return sendResponse(Controllers.generateClientAPIInterface(this.getApplication(), options));
    }
  }
}
