const MIGRATION_ID = '20220815183733';

export default {
  MIGRATION_ID,
  up: async function(connection, application) {
    const models = application.getModels();
    await connection.dropTables(models, { ifExists: true });
    await connection.createTables(models, { ifNotExists: true });
  },
  down: async function() {
  },
};
