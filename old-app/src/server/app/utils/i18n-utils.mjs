// This is just a shim for now, awaiting future I18N services.

export function langTerm(key, defaultValue, _options) {
  let options = _options || {};
  let {
    params,
  } = options;

  if (!params)
    params = {};

  let value;

  //value = lookupLanguageKey(key);

  if (!value)
    value = defaultValue;

  value = value.replace(/\{\{(\w+)\}\}/g, (m, paramName) => {
    let paramValue = params[paramName];
    return ((paramValue == null) ? '' : paramValue);
  });

  return value;
}
