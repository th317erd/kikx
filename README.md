# Kikx

Kikx is being rebuilt as a modular agent runner backed by a standalone AeorDB process over HTTP.

The previous Mythix/Mythix ORM/Solr implementation is archived in `old-app/` for reference while the new app is rebuilt around explicit services, repositories, plugins, and frame queues.

## Development

```bash
npm test
npm start
```

The new server expects AeorDB at `AEORDB_URL`, defaulting to `http://127.0.0.1:6830`.

