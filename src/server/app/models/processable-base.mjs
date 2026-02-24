import Nife           from 'nife';
import { DateTime }   from 'luxon';
import { Types }      from 'mythix';
import { ModelBase }  from './model-base.mjs';

const STALE_LOCK_MINUTES          = 15;
const MAX_FAIL_COUNT              = 50;
const FAILURE_NEXT_RETRY_SECONDS  = 30;

export class ProcessableBase extends ModelBase {
  static fields = {
    ...(ModelBase.fields || {}),
    order: {
      type:         Types.BIGINT,
      defaultValue: Types.BIGINT.Default.AUTO_INCREMENT,
      allowNull:    false,
      index:        true,
    },
    userID: {
      type:         Types.FOREIGN_KEY('User:id', {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
      allowNull:    false,
      index:        true,
    },
    lockedAt: {
      type:         Types.DATETIME,
      allowNull:    true,
      index:        true,
    },
    lockedBy: {
      type:         Types.STRING(32),
      allowNull:    true,
      index:        true,
    },
    successAt: {
      type:         Types.DATETIME,
      allowNull:    true,
      index:        true,
    },
    failedAt: {
      type:         Types.DATETIME,
      allowNull:    true,
      index:        true,
    },
    failedCount: {
      type:         Types.INTEGER,
      defaultValue: 0,
      allowNull:    false,
      index:        true,
    },
    retryAt: {
      type:         Types.DATETIME,
      allowNull:    true,
      index:        true,
    },
    failureMessage: {
      type:         Types.STRING(2048),
      allowNull:    true,
    },
  };

  static async shouldProcess() {
    return true;
  }

  static processableQueryHelper(query) {
    return query;
  }

  static async getBatchToProcess(lockID, callback, count = 20) {
    if (!(await this.shouldProcess()))
      return false;

    let processableModels;
    let processableUsers;

    const { User }          = this.getModels();
    const modelName         = this.getModelName();
    const ProcessableModel  = this.getModel(modelName);

    try {
      // Collect and lock
      processableModels = await this.getConnection().transaction(async () => {
        let processableQuery = ProcessableModel.where
          .successAt
            .EQ(null)
          .failedCount
            .LT(MAX_FAIL_COUNT)
          .AND(ProcessableModel.where.retryAt.EQ(null).OR.retryAt.LTE(DateTime.now()))
          .AND(ProcessableModel.where.lockedAt.EQ(null).OR.lockedAt.LTE(DateTime.now().minus({ minutes: STALE_LOCK_MINUTES })));

        processableQuery = this.processableQueryHelper(processableQuery);
        processableQuery = processableQuery
          .LIMIT(count)
          .ORDER(`+${this.getModelName()}:order`);

        let models = await processableQuery.all();
        if (models.length > 0) {
          let modelIDs = Nife.pluck('id', models);

          // Now lock these models for processing
          await ProcessableModel.where.id.EQ(modelIDs).update({
            lockedAt: DateTime.now(),
            lockedBy: lockID,
          });

          // Fetch all users for these models
          let userIDs = Nife.uniq(Nife.pluck('userID', models).filter(Boolean));
          let users   = await User.where.id.EQ(userIDs).all();

          processableUsers = Nife.toLookup('id', users);
        }

        return models;
      }, { lock: modelName });

      // Process models
      for (let i = 0, il = processableModels.length; i < il; i++) {
        let model = processableModels[i];
        let user  = processableUsers[model.userID];

        try {
          await callback(model, user, i);

          model.successAt = DateTime.now();
          await model.save();
        } catch (error) {
          try {
            let failedCount = model.failedCount || 0;
            failedCount++;

            model.failedAt = DateTime.now();
            model.failureMessage = error.message.slice(0, 2048);
            model.retryAt = DateTime.now().plus({ seconds: FAILURE_NEXT_RETRY_SECONDS * (failedCount * 2) });
            model.failedCount = failedCount;

            await model.save();
          } catch (error2) {
            this.getApplication().getLogger().error(`${modelName}::getBatchToProcess: Error while attempting to mark ${modelName} "${model.id}" as failed: `, error2, { originalFailureMessage: error.message });
          }
        }
      }

      return true;
    } catch (error) {
      this.getApplication().getLogger().error(`${modelName}::getBatchToProcess: Error while attempting to lock and send ${modelName} models: `, error);
      return false;
    } finally {
      try {
        // Now unlock models being processed
        if (Nife.isNotEmpty(processableModels)) {
          let modelIDs = Nife.pluck('id', processableModels);

          // Unlock models
          await this.getConnection().transaction(async () => {
            await ProcessableModel.where.id.EQ(modelIDs).update({
              lockedAt: null,
              lockedBy: null,
            });
          }, { lock: modelName });
        }
      } catch (error) {
        this.getApplication().getLogger().error(`${modelName}::getBatchToProcess: Error while attempting to unlock ${modelName} models: `, error);
      }
    }
  }
}
