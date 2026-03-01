'use strict';

import MythixORM from 'mythix-orm';

const { Model, Types } = MythixORM;

// =============================================================================
// ModelBase
// =============================================================================
// Base model for all Hero V2 models.
// Provides createdAt/updatedAt timestamps and helper methods.
// =============================================================================

export class ModelBase extends Model {
  static version = 1;

  static fields = {
    createdAt: {
      type:         Types.DATETIME,
      defaultValue: Types.DATETIME.Default.NOW,
      allowNull:    false,
      index:        true,
    },
    updatedAt: {
      type:         Types.DATETIME,
      defaultValue: Types.DATETIME.Default.NOW.UPDATE,
      allowNull:    false,
      index:        true,
    },
  };

  static defaultOrder() {
    return [ `${this.getModelName()}:createdAt` ];
  }

  getModel(modelName) {
    if (!modelName)
      return super.getModel();

    let connection = this.getConnection();
    return connection.getModel(modelName);
  }

  getModels() {
    let connection = this.getConnection();
    return connection.getModels();
  }
}

export { Model, Types };
