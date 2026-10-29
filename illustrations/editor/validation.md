# Parallel editor changes can disappear after successful calls

Functional priority is high, P1. The loss affects generated source changes and both tool calls report success. It requires overlapping built-in editor operations on the same normalized file path.

## Source and mechanism

Baseline is `51f63e4fd63aeeb74d708b9c3d1f8b800aff9b3e`. The tool description recommends batching non-overlapping edits. The runtime executes parallel calls with `Promise.all`. The editor reads and rewrites the full file, so two reads of the original contents can produce writes that lose one change.

The patch queues the whole existence check and edit operation for each normalized absolute path. The queue is shared by executor instances in the process. A rejected operation releases its successor, and the last operation removes its map entry. Different files remain independent.

## Test evidence

The deterministic regression controls read completion while retaining the real file writes. The baseline suite failed on the intended content assertion, with 13 existing tests passing.

```text
AssertionError: expected 'alpha: new\nbeta: old\n' to be 'alpha: new\nbeta: new\n'
Tests  1 failed | 13 passed (14)
```

After the patch, `python validate_editor.py` ran Vitest 4.0.18 against faithful temporary copies and passed 19 tests. The Bun bundle also passed. Additional cases cover multiple executor instances, Windows path casing, absolute and relative aliases, independent files, recovery after failure, insertion with replacement, and creation followed by editing. The worker also ran focused TypeScript checks using the real schemas and types with a minimal declaration for the shared package. This does not replace a full SDK typecheck.

The test and fix are separate commits, `50c81c8a3e48cb9c6771d13244698de6da360825` and `609110c7a773b9e9f376e04e29dd895d0010d181`. Biome and `git diff --check` passed. Tests used temporary sandboxes, bounded memory and workers, and immediate cleanup.

## Duplicate check and limits

Issue and PR searches covered open and closed states with `editor concurrent`, `editor serialize`, `editor race`, `editor lost update`, `same file parallel`, and `non-overlapping`. The reviewed reports #11784, #11598, #12219 and #14981 describe other mechanisms. No matching report was found by those searches.

This patch coordinates normalized paths in one module instance and process. It does not coordinate other processes, custom executors, symbolic-link aliases, or case aliases on macOS. The existing outer timeout does not cancel an edit, including an edit waiting for the queue. Full application and monorepo builds were not run.

Issue: https://github.com/cline/cline/issues/15417

The Poteto principles Fix Root Causes and Prove It Works required an actual failing content assertion before implementation and observed file contents after the patch. The independent Terra review accepted the editor patch with the limits above.
