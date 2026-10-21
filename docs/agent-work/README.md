# UI references and historical source maps

Current product work starts at [START-HERE](../START-HERE.md), the
[implementation plan](../implementation/backend-entrypoints.md) and root [working rules](../../AGENTS.md).
Nothing in this directory reserves paths, creates prerequisites or authorizes a separate work queue.

## Current UI references

Use selectively for React owner-interface work:

- [owner execution map](frontend-owner-execution-map.md);
- [Material UI playbook](frontend-material-agent-playbook.md);
- [NotebookLM visual reference](frontend-notebooklm-material-reference.md);
- [UI acceptance/manager boundary](frontend-autonomous-manager-runbook.md).

The current technical cutover is [frontend-platform-migration.md](../implementation/frontend-platform-migration.md).
Root rules own coordination and verification timing. Do not restore claim JSON, packet manifests, ancestry checks,
approval queues or a second frontend manager protocol.

## Historical ER documents

ER-00…ER-48 describe earlier capability locations and requirements. Their `Owned paths`, dependency lists, commands,
status references and acceptance programmes are historical evidence, not current instructions. Some named files and
commands have already been removed. Read an ER file only when tracing a predecessor or extracting a concrete fact;
verify it against current source and move any still-needed decision into the current owning implementation document.

The deleted machine-readable packet system remains available in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/tree/b920ea2f6184d04909ae0e6358947731066981bf/docs/agent-work).
After the last useful fact/reference is distilled, remove historical ER files from the working tree rather than
modernizing them into another specification.
