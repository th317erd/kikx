export async function create({ data }, callback) {
  const { Organization } = this.getModels();

  let organization = await Organization.create(Object.assign({
    name: 'Test',
  }, data || {}));

  if (typeof callback === 'function')
    return await callback.call(this, Object.assign({}, arguments[0], { organization }));

  return { organization };
}
