> **Current v3 documentation.** This page describes the unreleased third development revision. Source behavior wins if this page and the implementation differ.
>
> **Last verified:** 2026-10-27

# Deployment boundary

This repository defines the Kikx application, not its complete deployment. It has no canonical Dockerfile, production orchestrator definition, infrastructure provisioning workflow, backup schedule, TLS termination configuration, or release/promotion command.

The sibling **`kikx-docker` repository** owns the current deployment packaging and environment-specific procedures. Follow that repository's checked-out documentation for build, secret injection, database provisioning, rollout, rollback, and backup/restore commands. Do not copy a historical command from this application repository and assume it is current.

## What this repository guarantees

- the Node application entry point is `src/server/index.mjs`;
- `npm start` runs that entry point;
- listening host and port come from the Kikx configuration store;
- `GET /health` exposes application readiness;
- `SIGINT` and `SIGTERM` initiate the application drain sequence;
- PostgreSQL is the configured operational primary, but every deployment must explicitly select its driver; and
- static browser assets and discovered plugin assets are served by the application.

The root package currently identifies the third development revision, but no revision has been released publicly. Do not infer a stable public API, image tag policy, or compatibility guarantee from the package version alone.

## Deployment contract

An external deployment must provide:

1. a supported Node runtime and installed production dependencies;
2. explicit Kikx configuration, including database driver and connection settings;
3. protected secret delivery that does not bake credentials into images or logs;
4. durable storage and backend-native backup/restore for the selected database;
5. any required application data volume for configured local paths and external plugins;
6. network ingress, TLS, and access policy;
7. a supervisor that sends `SIGTERM` and allows the documented drain window;
8. readiness probing that parses `/health` and requires `ready: true`; and
9. stdout/stderr capture, rotation, and alerting.

External plugins are deployment inputs. Their code, dependencies, assets, configuration, and permission grants must travel with the deployment. Bundled plugins under `plugins/` are part of this source tree; an external plugin path is not.

## Release verification

Before promotion, use the exact application revision intended by the deployment repository and record both revisions together. Run the application test lanes against a disposable database, validate installed plugins, and rehearse database changes separately. After rollout:

1. wait for `ready: true`;
2. complete a real authentication round trip;
3. open an existing session and create a disposable one;
4. verify an asynchronous tool and its output path;
5. verify SSE reconnect behavior through the deployed ingress;
6. inspect startup/recovery logs; and
7. confirm backup monitoring independently of application health.

Rollback must account for database compatibility. Reverting application code does not automatically reverse data written by a newer revision or an executed migration.

## Historical compatibility traps

The application package and development scripts retain AeorDB-named commands, aliases, and wrappers. They exist for compatibility and migration work; they are not the current deployment contract. Likewise, browser automation scripts that obtain AeorDB tokens do not establish a production authentication architecture—Kikx authentication is native and driver-neutral.

## Sources of truth

- `package.json`
- `src/server/index.mjs`
- `src/server/create-server.mjs`
- `src/server/routes/infra-routes.mjs`
- `src/core/database/database-driver-selection.mjs`
- `plugins/`
- deployment procedures in the separately maintained `kikx-docker` repository

## Related

- [Development setup](../guides/development.md)
- [Testing guide](../guides/testing.md)
- [Configuration reference](../reference/configuration.md)
- [Plugin reference](../reference/plugins.md)
- [Runtime lifecycle](runtime-lifecycle.md)
- [Database operations](database.md)
- [Observability](observability.md)
