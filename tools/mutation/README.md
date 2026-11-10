# Mutation harness

`npm run mutation` checks the checks. It injects one small, deliberate bug at a time into a **copy** of the repository and runs the test
suites against it. A bug that makes a suite fail is *killed*; one that no suite notices *survived*, which means a missing test (or a
change that really does not matter: an *equivalent* or *redundant* mutant, to be recognised by reading it).

```
npm run mutation -- --check                 # do the patches still apply? (runs nothing, takes a second)
npm run mutation -- --only=M18 --jobs=1     # one mutant
npm run mutation -- --jobs=4                # all of them, four copies at a time (hours: each run is a full suite)
npm run mutation -- --only=M18 --repeat=5   # a kill has to be repeatable: five runs, five kills
```

- `mutants.mjs` holds the mutants. Each is a literal `from` → `to` patch of one file (`from` must occur exactly once), a
  `note` saying what bug it models, and a `suite`: `v` = `npm run verify`, `r` = `npm run verify:render` and then verify, `c` =
  `npm run verify:cs` and then verify. They started as the 85 mutants of the 2026-11 test audit (written against commit cf6b685) and were
  re-expressed against the code of Sprint 18; `status` says whether each one matched as it was (`same`), was rewritten for the code that
  replaced it (`reexpressed`) or models behaviour that is gone or never runs (`obsolete`, skipped).
- `run.mjs` copies the repository (without `.git`, `node_modules` and `backups`, and **without the per-install files**: the bot token, the
  saved voice config, room-password snapshots and atomic-write leftovers; the two `node_modules` folders are linked, not copied), applies a
  mutant to the copy, runs its suites there on ports of its own (24000 and up, each copy a block of 300; `--port-base=` picks another block, and
  the ports are checked free first; nothing near Streamer.bot's 7474 and 8080 or the bridge's 749x) with an allowlisted environment,
  stops at the first failing check, and appends one JSON line per mutant to the results file (default `<temp>/greenroom-mutation/results.jsonl`).
- Before a run of more than five mutants the suites are run once **without** a mutant (`--baseline`): a suite that is not green on its own would
  turn every mutant into a "kill", so a red baseline stops the run.
- A result is `KILLED` (with the failing check; `text: true` when it was a TRIPWIRE, a comparison of source text and not behaviour),
  `SURVIVED`, `FLAKY` (a kill that did not reproduce with `--confirm=1`), `ERROR` (a suite crashed or could not start: not a kill),
  `SKIPPED` (no C# compiler for a C# mutant: not a survival), `TIMEOUT` or `BADPATCH` (the code moved on: re-express the mutant).
- **Read a kill by an unrelated check with suspicion.** Several copies at once load the machine, and a timing-sensitive check can fail under load
  whatever the mutant does (R13e, GRN-22 and GRN-49 were seen to). Re-run such a mutant with fewer copies and `--confirm=1` before
  believing it.
- Nothing in this checkout is modified, and nothing connects to a live Streamer.bot, bridge or Discord: it is the same harness
  `npm run verify` and `npm run verify:render` are.

When code a mutant patches is rewritten, `--check` says so; re-express the mutant (same bug, new code) rather than deleting it.
