# GitHub issue tracker

The project's issue tracker is [TheDarkSkyXD/Sports-Hub on GitHub](https://github.com/TheDarkSkyXD/Sports-Hub/issues). The user explicitly selected GitHub Issues for planning and wayfinding. Do not create local Markdown tickets.

Use the `gh` CLI with `--repo TheDarkSkyXD/Sports-Hub`. For multiline bodies and comments, write a UTF-8 temporary file and use `--body-file`.

## Wayfinding operations

- Create the map as an issue labeled `wayfinder:map`.
- Create research and decision issues with `wayfinder:research` or `wayfinder:grilling`, then attach them through GitHub's sub-issues API.
- Record dependencies through `issues/{number}/dependencies/blocked_by` using the blocker's numeric database ID.
- Claim research by assignment before work. Only one non-research child may be claimed at a time.
- Find the next decision among open, unassigned sub-issues with no open blockers.
- Record a resolution as an issue comment, close the resolved child, and link its title with a one-line gist in the map's Decisions so far section.
- Keep research assets on linked research branches. Their reports are evidence, not another tracker.
- Product decisions that require the user remain open until the user answers. Recommendations are not resolutions.
