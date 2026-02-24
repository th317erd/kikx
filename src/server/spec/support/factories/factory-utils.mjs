let uuid = 1;

function resetUUIDCounter() {
  uuid = 1;
}

function getValue(value) {
  if (typeof value !== 'string')
    return value;

  return value.replace(/\{#\}/g, () => {
    return uuid++;
  });
}

function getValues(...args) {
  let finalData = Object.assign.apply(Object, [ {} ].concat(args.filter(Boolean)));
  let keys      = Object.keys(finalData);

  for (let i = 0, il = keys.length; i < il; i++) {
    let key   = keys[i];
    let value = finalData[key];

    if (typeof value === 'string')
      finalData[key] = getValue(value);
  }

  return finalData;
}

export {
  resetUUIDCounter,
  getValue,
  getValues,
};
