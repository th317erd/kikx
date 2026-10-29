# Todo focus frame index

This bundled plugin makes todo focus part of the durable frame record.

- It registers the `focus_todo_id` frame index with the plugin registry. AeorDB
  drivers merge that index into each session's interaction index config; SQL
  drivers that implement `ensureScalarIndex` create an equivalent expression
  index.
- A wildcard frame selector stamps `focus_todo_id` from the authoring agent's
  current todo focus. The stamp is a silent frame update, so it does not re-route
  an agent turn.
- It registers the `todo-frames` tool for querying frames by todo item. Results
  are locators; use `database-fetch` to read the frame bodies.

The todo store remains the source of truth for focus. This plugin only projects
that focus onto the frames produced while it is active.
