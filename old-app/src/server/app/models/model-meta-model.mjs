import { Types }      from 'mythix';
import { ModelBase }  from './model-base.mjs';
import Utils          from '../utils/index.mjs';

// This model is to have per-model meta information
// stored in the DB. For example, this model is used
// by the Notification model/system to know if
// Notifications are paused or not. Notifications might
// be paused for example during a transaction, when
// we want to ensure the transaction completes or
// rolls-back before we decide to send out notifications
// or not.

export class ModelMeta extends ModelBase {
  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: Utils.getModelIDPrefixFor('ModelMeta') }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    order: {
      type:         Types.BIGINT,
      defaultValue: Types.BIGINT.Default.AUTO_INCREMENT,
      allowNull:    false,
    },
    modelName: {
      type:         Types.STRING(32),
      allowNull:    false,
      index:        true,
    },
    name: {
      type:         Types.STRING(32),
      allowNull:    false,
      index:        true,
    },
    value: {
      type:         Types.STRING(64),
      allowNull:    true,
      index:        true,
    },
  };

  static defaultOrder() {}
}
