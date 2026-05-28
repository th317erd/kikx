# Mythix Translation Notes

The previous implementation used Mythix, Mythix ORM, SQLite, and Solr. Those concepts map into the rebuild as follows:

- Mythix `Application` lifecycle becomes explicit startup/shutdown functions.
- Mythix modules become normal services registered in `AppContext`.
- Mythix controllers become route handlers with explicit dependencies.
- Mythix ORM models become plain documents plus repository methods.
- Mythix model hooks become explicit domain events or service calls.
- Mythix query chains become AeorDB `/files/query` and `/files/search` calls.
- Solr indexing is replaced by AeorDB indexes and search.

