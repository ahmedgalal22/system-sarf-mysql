# Karta ERP — mandatory Git protocol

**Every Codex/development task: before editing ANY file, run the preflight below.** This includes resumed tasks. Do not install dependencies, generate files or run write-capable tools first. If the gate is missing, fails, or cannot reach the remote, **stop and report**; do not reconstruct or weaken the gate in that checkout. A matching branch name, a past PASS, a tracking ref, or matching application files is not proof of ancestry.

## Start a task (read-only)

```sh
cd /home/user/system-sarf-mysql && python3 -I -B tools/git_preflight.py
```

Use Git and Python 3 on the approved Linux workspace. `-I -B` isolates Python imports/environment and avoids bytecode files. The command must exit **0** and print `PASS` with two full SHAs. It does not authorize a commit, push, or change outside the requested task.

- Identity: this exact root with `karta/`, exactly one fetch and one push URL (`https://github.com/ahmedgalal22/system-sarf-mysql.git`), and `refs/heads/arena/b946ae4b-system-sarf-mysql`. Never substitute `main` or the source branch. A missing upstream is reported, not used as a fallback.
- History: **published floor ≤ live remote tip ≤ local HEAD**, where `≤` means ancestor or equal, not commit date. The approved local branch **may stay ahead of GitHub** by one or many commits. A clean, supported checkout at the live tip **or a provable descendant** is valid for startup. Behind, divergent or unproven history is a **STOP**. The gate reads the exact live ref twice and rechecks local state before success; a tracking ref is never a substitute. `2deb5a66e85f78d079a27575cae051ff46e83653` is the known published floor. Its parent `e3f9bef73c57f085d53c7cd9af550a84ec17adf3` is **not** a resume target. Shallow is acceptable only if the necessary ancestry can actually be proved locally.
- Protection: any staged, unstaged, deleted, untracked **or ignored** work blocks startup, as do operation/lock markers and index flags hiding work. Read `XY`, `??`, and `!!` in the report. Do **not** delete ignored files to pass. The inventories use NUL-delimited byte paths, not lines. Unexpected Git diagnostics (even at exit 0), malformed records and disagreeing inventories stop the check. A clean result also requires the HEAD tree, stage-0 index and an independent filesystem inventory to agree in paths, raw blob bytes and Git modes.
- Timing: a **new or resumed task** needs a fresh startup PASS. **During an already authorized active task**, intentional edits normally make the tree dirty. A subsequent startup check will STOP; that does not retroactively invalidate its original clean baseline, authorize cleanup, or grant a dirty-start exception. Preserve and report the work on handoff.
- Authority: **startup PASS never authorizes push**. Being locally ahead neither requires nor authorizes publication, merge, rebase, amendment or rewriting history. Commit and push each require explicit user approval.
- On `STOP`: report the failed condition, local/remote SHAs where safely available, and complete status. Preserve everything. Wrong identity: request the correct workspace. Behind **and dirty**: request a preservation plan; do not advance the branch. Clean and provably behind: an owner may **separately** authorize a fast-forward. Divergence, unknown commits, remote movement or an unfinished Git operation: stop for review. No automatic checkout, pull, merge, reset, clean, stash, rebase, cherry-pick, moving user files, or fallback branch.

### Supported checkout

Use a single-writer Linux checkout on a filesystem that preserves the owner executable bit, with `core.filemode=true`. The real root `.git/` must be the private Git **and** common directory, with a normal local index, SHA-1 object store and branch refs. No gitfiles, linked/shared worktrees, symlinked top-level metadata or symlinks in the active refs/objects/info storage, alternate object stores, grafts, promisor packs, partial clones, redirected worktree/index/object locations, or command-environment configuration overrides. The gate refuses relevant locks (including configuration, FETCH_HEAD, packed and loose refs) and ordinary merge, rebase, cherry-pick, revert or bisect state. This conservatively excludes some valid Git setups: their backing state may be elsewhere, shared, or modified by reading it.

Require a full, non-split, non-sparse index, no `core.ignoreStat`, submodules or skip-worktree/assume-unchanged entries. External clean/smudge/process filters are unsupported: inventory must not execute conversion programs. Built-in conversions are not trusted as proof of byte equality either: if e.g. EOL or encoding conversion leaves different raw working bytes, the checkout cannot PASS even if Git calls it clean. Regular files and symlink **targets as bytes** are checked without following those links. Empty working directories are not tracked content. These scans read file contents on both local checks; they are not a filesystem lock or a full object-store fsck. Do not change configuration or worktree contents just to make the gate pass.

**Missing objects / insufficient shallow history:** the check never fetches. Only after separate explicit authorization and verification of identity, a narrowly scoped object fetch is possible:

```sh
git fetch --no-tags --no-prune --no-recurse-submodules --no-auto-maintenance \
  --refmap= origin refs/heads/arena/b946ae4b-system-sarf-mysql
```

This writes objects and `FETCH_HEAD`. With no destination and an empty refmap it does not move the local branch or refresh unrelated tracking refs. It is **not** part of preflight and is not permission to reconcile anything. If additional depth is needed, obtain authorization for that exact branch and scope separately. Rerun the gate; fetching alone does not advance HEAD.

## Publication checklist (separate from startup)

`PASS: startup` validates a task baseline. `--publication TIP CANDIDATE` applies **all** the same checks and additionally binds the exact previously reviewed live SHA and local HEAD; its result is labelled `PASS: publication-candidate`. It is not a startup equality rule, a review of the code changes, or permission to push. Human authorization is required for staging, committing, and pushing. The verifier performs **none** of these actions. Do not publish partial work to make a dirty preflight pass.

1. Agree on the exact intended paths, changes and tests. Before staging, inspect the complete worktree/index and untracked/ignored inventory. With authorization, stage **only** approved paths/hunks; no blanket add or commit-all. Inspect `git --no-optional-locks diff --cached --name-status` and `git --no-optional-locks diff --cached --no-ext-diff --no-textconv --full-index --binary` without a path limit. Check new files in full. Stop on any unrelated content; never unstage, stash or discard someone else's work. Commit only with authorization.
2. On the resulting clean checkout, run the startup gate again. From its **PASS** record the full `remote` SHA as `TIP` and full `HEAD` SHA as `CANDIDATE`. Do not derive `TIP` from `origin/...` or the historical floor. If equal there is nothing to publish. Review **every** outgoing commit, the full changed-path list, and the complete diff, including binary changes:

   ```sh
   git --no-replace-objects log --reverse --format=fuller "$TIP..$CANDIDATE"
   git --no-replace-objects diff --name-status "$TIP" "$CANDIDATE" --
   git --no-replace-objects diff --no-ext-diff --no-textconv --full-index --binary "$TIP" "$CANDIDATE" --
   ```

   Inspect each outgoing commit's patch as well (`git --no-replace-objects show -m --no-ext-diff --no-textconv --full-index --binary <commit>`). A clean final tree or small net diff can hide unrelated intermediate commits. Stop if any commit, path, content, test outcome or commit parent is not approved.
3. Obtain explicit approval for **this candidate, this remote tip, and this branch**. Immediately before pushing, from the approved root run:

   ```sh
   python3 -I -B tools/git_preflight.py --publication "$TIP" "$CANDIDATE"
   ```

   Nonzero exit, a different SHA, a dirty tree or a changed remote: **do not push**. Review from the beginning, not just the new tip. Read-only observations cannot lock GitHub. If concurrent publishers are possible, require an exclusive publication window or server-side expected-tip check; otherwise stop.
4. **Only after approval and PASS**, use one ordinary non-forced push, pinning the reviewed commit to the exact destination:

   ```sh
   REF=refs/heads/arena/b946ae4b-system-sarf-mysql
   git push --no-follow-tags --recurse-submodules=no origin "$CANDIDATE:$REF"
   ```

   No `+`, force/lease, mirror, tags, other branches or automatic retry. A normal push rejects a non-fast-forward; it is not an atomic expected-old-SHA lock across a prior review. If rejected, stop. Never rewrite history to obtain a pass.
5. Independently run `git ls-remote --exit-code --refs origin "$REF"`. Require exactly one result for that ref whose **full SHA equals `CANDIDATE`**. Report the verified SHA; on missing/different output or network failure, report unverified publication and stop. Do not push again to “correct” it.

## Scope and tests

Run the offline integration suite with `python3 -I -B tools/test_git_preflight.py`. It creates disposable repositories in `/tmp`, allows only file transport, and compares local working files and all Git metadata before/after each gate invocation.

This is a point-in-time gate, not a lock, hook installation or scheduler. Use a trusted Git installation/configuration and a single writer to the checkout. Rerun after any context handoff or outside change. An agent or trusted task runner must **invoke** the gate before editing; a script in the repository cannot enforce that itself. The platform must provision/resume from the live approved branch or preserve Git metadata **and** user files together. It must preserve unpublished/ignored work across workspace replacement. Neither the script nor a successful push provides that persistence.
