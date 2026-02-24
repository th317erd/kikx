import { DateTime }         from 'luxon';
import { Types }            from 'mythix';
import { ProcessableBase }  from './processable-base.mjs';
import Utils                from '../utils/index.mjs';

// This model is designed so that all notifications
// should be sent using this. This is so that
// the company can track all notifications, and
// also so that notifications are not lost on
// shutdown/restart.

export class Notification extends ProcessableBase {
  static fields = {
    ...(ProcessableBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: Utils.getModelIDPrefixFor('Notification') }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    type: {
      type:         Types.STRING(32),
      allowNull:    false,
      index:        true,
    },
    category: {
      type:         Types.STRING(64),
      allowNull:    false,
      index:        true,
    },
    subject: {
      type:         Types.TEXT(128),
      allowNull:    true,
      index:        true,
    },
    content: {
      // eslint-disable-next-line no-magic-numbers
      type:         Types.TEXT(65565),
      allowNull:    true,
      index:        false,
    },
    deliverAt: {
      type:         Types.DATETIME,
      defaultValue: Types.DATETIME.Default.NOW,
      allowNull:    false,
      index:        true,
    },
    user: {
      type:         Types.Model('User', ({ self }, { User }, userQuery) => {
        return User.$.id.EQ(self.userID).MERGE(userQuery);
      }),
    },
  };

  static async shouldProcess() {
    return !(await this.areNotificationsPaused());
  }

  static processableQueryHelper(query) {
    return query.AND[this.getModelName()]
        .deliverAt
          .LTE(DateTime.now());
  }

  static async areNotificationsPaused() {
    let { ModelMeta } = this.getModels();

    await this.getConnection().transaction(async () => {
      let count = await ModelMeta.$.modelName.EQ('Notification').name.EQ('paused').value.EQ('true').count();
      return (count > 0);
    }, { lock: 'ModelMeta' });
  }

  static async pauseNotifications() {
    let { ModelMeta } = this.getModels();

    await this.getConnection().transaction(async () => {
      let alreadyPaused = await ModelMeta.$.modelName.EQ('Notification').name.EQ('paused').ORDER('-ModelMeta:order').first();
      if (alreadyPaused && alreadyPaused.value !== 'true') {
        alreadyPaused.value = 'true';
        await alreadyPaused.save();

        return;
      }

      await ModelMeta.create({
        modelName:  'Notification',
        name:       'paused',
        value:      'true',
      });
    }, { lock: 'ModelMeta' });
  }

  static async unpauseNotifications() {
    let { ModelMeta } = this.getModels();

    await this.getConnection().transaction(async () => {
      await ModelMeta.$.modelName.EQ('Notification').name.EQ('paused').destroy();
    }, { lock: 'ModelMeta' });
  }
}
