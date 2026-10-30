# Development Revision History

> **Historical lineage guide.** This page distinguishes Kikx's internal development revisions from package versions and public releases.

Kikx is currently in its **third development revision**. The first and second development revisions encountered problems large enough that they were scrapped and replaced instead of released. No Kikx development revision has been released publicly.

These revision numbers describe project lineage only:

- **Development revision 1:** unreleased and scrapped.
- **Development revision 2:** unreleased and scrapped.
- **Development revision 3:** the current development line represented by this repository.

“Development revision 3” is not a package semantic version, protocol version, database schema version, API version, or claim that a public Kikx 1.0 or 2.0 existed. Package manifests and individual components may use their own version numbers independently.

The repository retains bounded historical evidence from earlier work, including the legacy Mythix implementation under `old-app/` and documents that use names such as `kikx2`. Those names are useful for locating evidence, but they are not authoritative revision labels. The surviving material does not establish which specific failures ended each earlier revision, so this history intentionally does not speculate about them.

Historical plans, reports, incidents, and migrations preserve what was believed or observed at a particular time. They do not define current development-v3 behavior. For current behavior, prefer executable source and tests, followed by current canonical documentation.

## Revision References

- [Mythix translation notes](./legacy-mythix-translation.md) — retained context for concepts carried forward from the legacy Mythix-based implementation. The surviving evidence does not assign every described artifact to a specific numbered development revision.
