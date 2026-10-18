# Owner-web delivery map

Use [the current plan](../implementation/backend-entrypoints.md) for assignments and
[the architecture](../architecture/ELIOT_RESEARCH.md) for product scope. This map describes UI outcomes,
not a DAG of approvals. The frontend claim registry, files and ancestry tools have been removed from this branch.
Their dated source remains in Git history; they are not an optional tool to keep running.

## Build the selected interface

Use the existing React/Vite application, UI system and one owner client. Keep URL-owned navigation,
bounded in-memory query state and native HTML semantics. Sources, Research/Evidence, Studio/Wiki/Inbox
and Connections must expose the actual selected capabilities, not decorative unavailable features.
The ordinary streamed answer is selected work: change its real server/client contract together;
no separate approval queue for that integration and no invented completion or connection state.

Review Material direction in the existing playbook before changing visual design. Keep coherent desktop
and phone layouts, light/dark themes, long Russian/English text, and useful loading/error/degraded states.
Do not repeat research or rebuild the design system merely because another agent starts work.

Assemble project → source → question → report → exact citation → reopen, Inbox publication,
and agent connection/task-result journeys. Prefer an independent no-hint usability review when available;
otherwise state the review limitation. An unavailable reviewer is not a blocker to implementation.

## Review and cutover

During implementation use scoped compilation/lint. After assembly check selected browser journeys,
keyboard/focus, responsive layout, accessibility, safe rendering, network behavior and private-data lifecycle.
A screenshot or isolated story is not product acceptance. Record actual failures and unrun checks honestly.
The owner reviews the finished integrated interface; internal edits need no separate approval receipt.

Prepare the integrated Worker/assets build and rollback before final UI review. The
[cutover contract](../implementation/frontend-platform-migration.md) owns deployment, standalone Inbox,
service-worker retirement and lifecycle details; do not duplicate that machinery here.
One manager assigns disjoint files and integrates shared paths under root rules. No claims, path-lock
manifest or Git-history ceremony is required to edit an authorized file.
