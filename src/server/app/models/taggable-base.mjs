import Nife           from 'nife';
import { ModelBase }  from './model-base.mjs';

export class TaggableBase extends ModelBase {
  static _sanitizeTagName(tagName) {
    if (!tagName)
      return;

    return ('' + tagName).toLowerCase().replace(/[^\w_-]/g, '');
  }

  _sanitizeTagName(tagName) {
    return this.constructor._sanitizeTagName(tagName);
  }

  _prepareTags(_tagNames) {
    let tagNames = Nife.arrayFlatten(Nife.toArray(_tagNames)).filter((tagName) => {
      if (Nife.isEmpty(tagName))
        return false;

      if (!Nife.instanceOf(tagName, 'string'))
        return false;

      return true;
    }).map((tagName) => this._sanitizeTagName(tagName));

    if (Nife.isEmpty(tagNames))
      return;

    return tagNames;
  }

  _getTargetAttributes(target) {
    let { type, id } = (this.getModelTypeAndID(target) || {});
    if (!type || !id)
      return;

    return {
      targetType: type,
      targetID:   id,
    };
  }

  _generateQuery(target, _options) {
    let targetAttrs = this._getTargetAttributes(target);
    let options     = _options || {};
    let Tag         = this.getModel('Tag');
    let userQuery   = options.userQuery;

    let query = Tag.where.DISTINCT.sourceID.EQ(this.id).AND.sourceType.EQ(this.getModelName());

    if (targetAttrs)
      query = query.targetID.EQ(targetAttrs.targetID).targetType.EQ(targetAttrs.targetType);

    if (options.names) {
      let tagNames = this._prepareTags(options.names);
      if (Nife.isNotEmpty(tagNames))
        query = query.name.EQ(tagNames);
    }

    if (options.noOrder !== true)
      query = query.ORDER('+Tag:name');

    if (userQuery)
      query = query.MERGE(userQuery);

    return query;
  }

  async countTags(target, _options) {
    let query = this._generateQuery(target, Object.assign({}, _options || {}, { noOrder: true }));
    return await query.count(null, _options);
  }

  async getTags(target, _options) {
    let options = _options || {};
    let query   = this._generateQuery(target, _options);

    if (options.attributes)
      return await query.pluck(options.attributes, options);

    return await query.all(options);
  }

  async addTags(target, _tagNames, options) {
    let tagNames = this._prepareTags(_tagNames);
    if (!tagNames)
      return;

    let targetAttrs     = await this._getTargetAttributes(target);
    let currentTagNames = await this.getTags(target, Object.assign({}, options || {}, { attributes: 'Tag:name' }));
    let tagNamesToAdd   = Nife.arraySubtract(tagNames, currentTagNames);

    if (Nife.isEmpty(tagNamesToAdd))
      return;

    let Tag         = this.getModel('Tag');
    let sourceID    = this.id;
    let sourceType  = this.getModelName();

    let tags = tagNamesToAdd.map((name) => {
      let tag = new Tag({
        sourceID,
        sourceType,
        name,
      });

      if (targetAttrs)
        tag.setAttributes(targetAttrs);

      return tag;
    });

    return await Tag.create(tags, options);
  }

  async removeTags(target, _tagNames, _options) {
    let tagNames = Nife.toArray(_tagNames).filter(Boolean);
    if (Nife.isEmpty(tagNames))
      return;

    let options = Object.assign({}, _options || {}, { names: tagNames });
    let query   = this._generateQuery(target, options);

    return await query.destroy(options);
  }
}
