# PWA Charter

This document defines the format and operating agreement for Project Working
Agreements (PWAs). It is framework governance text. It is not a project PWA,
a Task state machine, or an authorization policy.

## Responsibilities

The framework and plugin provide agent identity, role class, available tools,
Task and Activity persistence, message delivery, and authorization. A PWA
provides the project-specific workflow meaning: responsibilities, evidence
expectations, escalation, remote-effect rules, and stable operating notes.
A PWA can explain how an agent should use a capability; it cannot grant a
capability or override framework authorization.

The fixed role classes are `planner`, `supervisor`, and `worker`. A role file
defines a project-specific role within one of those classes. The role class
selects framework guidance; the role supplies scoped project guidance. Neither
should be used as a second agent identity or as a substitute for a Task.

## Source package

A PWA is a human-readable directory, normally kept in a Git-managed location:

```text
PWA.md
roles/<role-slug>.md
```

`PWA.md` contains project-wide guidance. The selected role file contains the
guidance for one role. The v0 parser requires this frontmatter:

- `PWA.md`: `version: 1`, a non-empty `project`, and optional `statuses`.
- `roles/<role-slug>.md`: `version: 1` and `roleClass: planner`, `supervisor`,
  or `worker`; `title` is optional.

Statuses are project vocabulary. The plugin stores them as strings and does
not infer transitions or compile a gate engine from them.

## Context assembly

For an agent created through the plugin, the system prompt is assembled in
this order:

1. framework role-class settings, enclosed by
   `<paseo-swarm-system-settings>`;
2. project PWA body;
3. selected role body;
4. the current orientation and other work context.

The role-class block is framework guidance, not a hidden permission channel.
The plugin uses Paseo's `systemPrompt` agent configuration for this initial
assembly. Agents created outside the plugin may require explicit registration
before the plugin can provide the same context.

When context is rebuilt after compaction, the role-class settings and the
current PWA/role context must be restored before new Task context.
The plugin does not treat a transcript summary as a replacement for these
settings.

## Revisions and proposals

The plugin computes a revision from the PWA and selected role source files.
Changing either source changes the revision used for newly assembled context.
Task and Activity records carry work facts and evidence; stable workflow rules
belong in the PWA rather than being reconstructed from those records.

The v0 plugin does not implement PWA proposal approval or activation. A future
proposal flow should keep a candidate separate from the active source, require
the project's chosen human or planner decision, and record the activated
revision. Running work may continue under the revision it already received
until the workflow explicitly refreshes it.
