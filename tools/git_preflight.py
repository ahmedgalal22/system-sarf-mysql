#!/usr/bin/env python3
"""Read-only Karta checkout gate. Production identity has no CLI/env overrides."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from typing import NamedTuple

BRANCH = 'arena/b946ae4b-system-sarf-mysql'
REF = 'refs/heads/' + BRANCH


class Project(NamedTuple):
    root: Path
    origin: str
    published_floor: str  # A trust anchor, NOT a substitute for reading the live tip.


KARTA = Project(Path('/home/user/system-sarf-mysql'),
                'https://github.com/ahmedgalal22/system-sarf-mysql.git',
                '2deb5a66e85f78d079a27575cae051ff46e83653')
OID = re.compile(r'[0-9a-f]{40}')
OPERATIONS = ('MERGE_HEAD', 'MERGE_AUTOSTASH', 'MERGE_MODE', 'AUTO_MERGE', 'MERGE_RR',
              'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-apply', 'rebase-merge',
              'sequencer', 'BISECT_START', 'BISECT_LOG')
REDIRECTS = ('GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
             'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_NAMESPACE',
             'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS')


class Stop(Exception):
    """A failed or inconclusive check is never permission to continue."""


def git(cwd, *args, ok=(0,), data=b''):
    # No optional index refresh, external hooks, credential prompts/storage or implicit fetch.
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_TRACE')}
    env.update(GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0', GIT_ASKPASS='/bin/false',
               SSH_ASKPASS='/bin/false', LC_ALL='C', GIT_TRACE2='0', GIT_TRACE2_EVENT='0', GIT_TRACE2_PERF='0')
    cmd = ['git', '--no-optional-locks', '--no-replace-objects', '-c', 'core.untrackedCache=false',
           '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + os.devnull,
           '-c', 'credential.helper=', '-c', 'http.saveCookies=false', *args]
    p = subprocess.run(cmd, cwd=cwd, env=env, input=data, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, timeout=30)
    # Even a successful status/ls-files can warn that a directory could not be read.
    # Never print raw stdout/stderr, configuration values or an unverified remote URL on error.
    if p.stderr:
        raise Stop(f'git {args[0]} reported unexpected diagnostics (exit {p.returncode}); output withheld.')
    if p.returncode not in ok or (p.returncode and p.stdout):
        raise Stop(f'git {args[0]} failed or returned unexpected data (exit {p.returncode}).')
    return p


def line(p):
    value, sep, tail = p.stdout.partition(b'\n')
    if not sep or tail or b'\0' in value or b'\r' in value:
        raise Stop('Malformed or incomplete single-line Git response.')
    return os.fsdecode(value)


def records(raw):
    if not raw:
        return []
    fields = raw.split(b'\0')
    if fields.pop() or b'' in fields:
        raise Stop('Malformed or incomplete NUL-delimited Git inventory.')
    return fields


def bool_config(cwd, key):
    p = git(cwd, 'config', '--bool', '--get', key, ok=(0, 1))
    if p.returncode == 1:
        return None
    if p.stdout not in (b'true\n', b'false\n'):
        raise Stop('Malformed boolean Git configuration response.')
    return p.stdout == b'true\n'


def live_tip(cwd):
    p = git(cwd, 'ls-remote', '--exit-code', '--refs', 'origin', REF, ok=(0, 2))
    if p.returncode == 2:
        raise Stop(f'Approved remote ref {REF} is missing. Confirm it with the owner; no fallback.')
    match = re.fullmatch(rb'([0-9a-f]{40})\t' + re.escape(REF.encode()) + rb'\n', p.stdout)
    if not match:
        raise Stop(f'Expected exactly one complete SHA and {REF} from origin. Verify the advertisement.')
    return match[1].decode('ascii')


def storage(cwd):
    gd = cwd / '.git'
    if gd.is_symlink() or not gd.is_dir():
        raise Stop('Unsupported .git layout: require a private directory, not a gitfile, link or linked worktree.')
    # Check before anything reads the index or traverses the object graph. scandir propagates read errors.
    operations = [name for name in OPERATIONS if os.path.lexists(gd / name)]
    if operations:
        raise Stop('In-progress operation or lock: ' + ', '.join(operations) + '. Leave it for its owner.')
    pending = [gd]
    while pending:
        folder = pending.pop()
        with os.scandir(folder) as entries:
            for e in entries:
                path = Path(e.path)
                if e.name.endswith('.lock'):
                    raise Stop('In-progress operation or lock: ' + display(os.fsencode(path.relative_to(gd)))
                               + '. Leave it for its owner.')
                if e.is_symlink():
                    raise Stop('Symlinked Git storage is unsupported; request a self-contained checkout.')
                if folder == gd and e.name.startswith('sharedindex.'):
                    raise Stop('Split-index metadata: reading the index can refresh its shared file.')
                if folder == gd and e.name in ('commondir', 'gitdir', 'worktrees'):
                    raise Stop('Linked/shared worktree metadata; require one private checkout.')
                if (path in (gd / 'info/grafts', gd / 'objects/info/alternates', gd / 'objects/info/http-alternates')
                        or (folder == gd / 'objects/pack' and e.name.endswith('.promisor'))):
                    raise Stop('Graft, alternate or promisor metadata; require independent local history.')
                if e.is_dir(follow_symlinks=False):
                    if folder != gd or e.name in ('refs', 'objects', 'info'):
                        pending.append(path)
                elif not e.is_file(follow_symlinks=False):
                    raise Stop('Special file in Git storage; cannot certify a regular private checkout.')
    if not all((gd / n).is_file() for n in ('HEAD', 'config', 'index')):
        raise Stop('Missing or non-regular private Git HEAD, config or index.')
    layout = git(cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir',
                 '--git-common-dir', '--git-path', 'index').stdout
    if layout != b''.join(os.fsencode(p) + b'\n' for p in (cwd, gd, gd, gd / 'index')):
        raise Stop('Unexpected resolved root, Git directory, common directory or index path.')
    if line(git(cwd, 'rev-parse', '--is-inside-work-tree')) != 'true' or line(git(cwd, 'rev-parse', '--show-object-format')) != 'sha1':
        raise Stop('Require a non-bare SHA-1 working checkout.')
    unsupported = git(cwd, 'config', '--null', '--name-only', '--get-regexp',
                      r'^(core\.worktree|extensions\.partialclone|remote\..*\.(promisor|partialclonefilter)|filter\..*\.(clean|smudge|process))$', ok=(0, 1))
    if unsupported.returncode == 0:
        keys = records(unsupported.stdout)
        if not keys:
            raise Stop('Incomplete configuration inventory.')
        reason = ('External filter' if any(k.startswith(b'filter.') for k in keys) else
                  'Worktree redirection' if b'core.worktree' in keys else 'Partial-clone configuration')
        raise Stop(reason + ': request a supported checkout.')
    if bool_config(cwd, 'core.filemode') is not True:
        raise Stop('Require core.filemode=true on a filesystem with observable executable bits.')
    for key in ('core.splitIndex', 'core.sparseCheckout', 'core.ignoreStat', 'extensions.worktreeConfig'):
        if bool_config(cwd, key):
            raise Stop(f'Unsupported {key} configuration; require an ordinary full index and worktree.')


def path_field(path, *, directory=False):
    name = path[:-1] if directory and path.endswith(b'/') else path
    if any(part in (b'', b'.', b'..', b'.git') for part in name.split(b'/')):
        raise Stop('Malformed repository-relative path in Git inventory.')
    return path


def display(path):
    # Keep byte paths intact for comparison; quote whitespace/control/non-UTF-8 bytes only for display.
    if re.fullmatch(rb'[!-~]+', path) and b'"' not in path and b'\\' not in path:
        return path.decode('ascii')
    return json.dumps(os.fsdecode(path), ensure_ascii=True)


def index_inventory(cwd):
    result, seen, flags = {}, set(), set()
    for rec in records(git(cwd, 'ls-files', '-v', '--stage', '-z').stdout):
        meta, tab, name = rec.partition(b'\t')
        m = re.fullmatch(rb'([HhSsMm]) (100644|100755|120000|160000) ([0-9a-f]{40}) ([0-3])', meta)
        if not tab or not m or (name, m[4]) in seen:
            raise Stop('Malformed or duplicate index inventory entry.')
        path_field(name)
        seen.add((name, m[4]))
        if m[1] != b'H' or m[4] != b'0':
            flags.add('Index has unmerged, skip-worktree/assume-unchanged paths. Status cannot certify cleanliness.')
        if m[2] == b'160000':
            flags.add('Submodule checkout: nested repositories were not inspected.')
        result[name] = (m[2], m[3])
    return result, sorted(flags)


def status_inventory(cwd, has_submodule):
    raw = git(cwd, 'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all',
              '--ignored', '--ignore-submodules=' + ('all' if has_submodule else 'none')).stdout
    rows = []
    for rec in records(raw):
        xy, space, path = rec[:2], rec[2:3], rec[3:]
        if space != b' ' or xy == b'  ' or not re.fullmatch(rb'\?\?|!!|[ MADT][ MADT]|AU|UD|UA|DU|UU', xy):
            raise Stop('Malformed porcelain status inventory.')
        rows.append((xy, path_field(path, directory=xy in (b'??', b'!!'))))
    if len(set(rows)) != len(rows):
        raise Stop('Duplicate porcelain inventory entry.')
    for tag, extra in ((b'??', ()), (b'!!', ('--ignored',))):
        names = [path_field(p, directory=True) for p in records(
            git(cwd, 'ls-files', '--others', *extra, '--exclude-standard', '-z').stdout)]
        if len(set(names)) != len(names) or set(names) != {p for xy, p in rows if xy == tag}:
            raise Stop('Inconsistent untracked/ignored inventories. Preserve the checkout; cannot certify completeness.')
    return rows


def raw_entry(entry):
    """Compute Git mode and unfiltered blob ID without trusting the index's stat cache."""
    def stamp(st):
        return st.st_dev, st.st_ino, st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns

    st = entry.stat(follow_symlinks=False)
    h = hashlib.sha1(b'blob ' + str(st.st_size).encode() + b'\0')
    if stat.S_ISLNK(st.st_mode):
        mode = b'120000'
        h.update(os.readlink(entry.path))  # link bytes, never the target file
    elif stat.S_ISREG(st.st_mode):
        mode = b'100755' if st.st_mode & stat.S_IXUSR else b'100644'
        with os.fdopen(os.open(entry.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as f:
            if stamp(os.fstat(f.fileno())) != stamp(st):
                raise Stop('Working path changed before reading it. Stop concurrent work and rerun.')
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
    else:
        raise Stop('Special file in worktree: cannot verify its bytes or mode.')
    if stamp(os.stat(entry.path, follow_symlinks=False)) != stamp(st):
        raise Stop('Working path changed during inventory. Stop concurrent work and rerun.')
    return mode, h.hexdigest().encode()


def verify_clean_files(cwd, head, index):
    # Well-framed Git output can still omit whole records. Verify a candidate clean result independently.
    tree = {}
    for rec in records(git(cwd, 'ls-tree', '-r', '--full-tree', '-z', head).stdout):
        meta, tab, name = rec.partition(b'\t')
        m = re.fullmatch(rb'(100644|100755|120000) blob ([0-9a-f]{40})', meta)
        if not tab or not m or path_field(name) in tree:
            raise Stop('Malformed or duplicate HEAD tree inventory entry.')
        tree[name] = (m[1], m[2])
    if tree != index:
        raise Stop('HEAD tree and index inventories disagree despite clean status.')
    seen = set()
    pending = [b'']
    root = os.fsencode(cwd)
    while pending:
        parent = pending.pop()
        with os.scandir(os.path.join(root, parent)) as entries:
            for entry in entries:
                name = os.path.join(parent, entry.name)
                if name == b'.git':
                    continue
                if entry.is_dir(follow_symlinks=False):
                    pending.append(name)
                    continue
                if name not in tree:
                    raise Stop('Filesystem contains a path missing from the clean Git inventory.')
                if raw_entry(entry) != tree[name]:
                    raise Stop('Raw working bytes or Git mode differ from HEAD despite clean status.')
                seen.add(name)
    if seen != tree.keys():
        raise Stop('Filesystem and tracked-path inventories disagree despite clean status.')


def local_state(cwd, project, *, quiet=False):
    if (cwd / 'karta').is_symlink() or not (cwd / 'karta').is_dir():
        raise Stop('Wrong root: require the approved checkout with karta/ present.')
    storage(cwd)
    p = git(cwd, 'symbolic-ref', '--no-recurse', '-q', 'HEAD', ok=(0, 1))
    branch = '' if p.returncode else line(p)
    head = line(git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}'))
    shallow = line(git(cwd, 'rev-parse', '--is-shallow-repository'))
    if not OID.fullmatch(head) or shallow not in ('true', 'false'):
        raise Stop('Unrecognized HEAD or shallow state. Verify repository integrity.')
    upstream = '(none)'
    if branch == REF:
        # Require one direct branch record at HEAD. A missing upstream is not a missing record.
        fmt = '--format=%(refname)%00%(objectname)%00%(symref)%00%(upstream)'
        row = git(cwd, 'for-each-ref', fmt, REF).stdout
        prefix = REF.encode() + b'\0' + head.encode() + b'\0\0'
        approved = 'refs/remotes/origin/' + BRANCH
        if row == prefix + approved.encode() + b'\n':
            upstream = approved
        elif row != prefix + b'\n':
            raise Stop('Unexpected upstream, indirect branch or incomplete approved ref record.')
    index, problems = index_inventory(cwd)
    rows = status_inventory(cwd, any(mode == b'160000' for mode, _ in index.values()))
    if not quiet or rows or branch != REF:
        status = '\n'.join(xy.decode('ascii') + ' ' + display(p) for xy, p in rows)
        branch_label = REF if branch == REF else ('(other branch)' if branch else '(detached)')
        print(f'Root: {cwd}\nBranch: {branch_label}\nHEAD: {head}\nShallow: {shallow}'
              f'\nApproved branch upstream: {upstream}\nGit status (XY, ?? untracked, !! ignored):\n{status or "(clean)"}')
    if branch != REF:
        raise Stop(f'Wrong branch; require {REF}. Request the approved checkout. No remote contacted.')
    for direction, options in [('fetch', []), ('push', ['--push'])]:
        if git(cwd, 'remote', 'get-url', *options, '--all', 'origin').stdout != os.fsencode(project.origin) + b'\n':
            raise Stop(f'Wrong origin {direction} URL(s); require exactly {project.origin}. No remote contacted.')
    if bool_config(cwd, 'remote.origin.mirror'):
        raise Stop('Origin is configured as a mirror, not a single-branch push target.')
    if rows:
        problems.append('Staged, unstaged, untracked or ignored work is present. Preserve and review the status above.')
    if not problems:
        verify_clean_files(cwd, head, index)
    return head, shallow == 'true', problems


def prove_history(cwd, floor, tip, head, shallow):
    for role, oid in [('live remote tip', tip), ('published floor', floor)]:
        # batch-check returns an explicit '<oid> missing' on stdout, without accepting arbitrary stderr.
        obj = git(cwd, 'cat-file', '--batch-check', data=(oid + '\n').encode()).stdout
        if obj == (oid + ' missing\n').encode():
            raise Stop(f'No local commit object for {role} {oid}. Ancestry unproven; request a separate, exact-branch fetch.')
        if not re.fullmatch(oid.encode() + rb' commit [0-9]+\n', obj):
            raise Stop(f'Could not verify the local commit object for {role}. Ancestry unproven.')

    def ancestor(a, b):
        result = git(cwd, 'merge-base', '--is-ancestor', a, b, ok=(0, 1))
        if result.stdout:
            raise Stop('Unexpected ancestry response. Ancestry unproven.')
        return result.returncode == 0

    incomplete = 'Insufficient shallow history to prove ancestry. Request sufficient history for the approved branch.'
    if not ancestor(floor, tip):
        raise Stop(incomplete if shallow else f'Remote tip does not descend from published floor {floor}. Review possible remote history change.')
    if ancestor(tip, head):  # equality OR any provable number of local commits ahead
        return
    if ancestor(head, tip):
        raise Stop('Local HEAD is behind the live remote tip. Preserve local work; request a separately reviewed fast-forward plan.')
    raise Stop(incomplete if shallow else 'Local and remote histories diverge. Ask the owner to review both histories; do not rewrite either.')


def preflight(cwd, project, publication=None):
    """Both modes are read-only. Only candidate validation binds a separately reviewed SHA pair."""
    try:
        if any(k in os.environ for k in REDIRECTS):
            raise Stop('Git repository/index/object or configuration redirection is active. Request a normal checkout; no repository inspected.')
        cwd = cwd.resolve()
        if cwd != project.root:
            raise Stop(f'Wrong root: cwd={cwd}; run at {project.root}. No repository inspected.')
        head, shallow, problems = local_state(cwd, project)
        tip = live_tip(cwd)
        print(f'Origin (fetch and push): {project.origin}\nLive {REF}: {tip}\nPublished floor: {project.published_floor}')
        if publication is not None and tuple(publication) != (tip, head):
            problems.append('Reviewed remote/HEAD pair no longer matches. Stop and review again.')
        try:
            prove_history(cwd, project.published_floor, tip, head, shallow)
        except Stop as e:
            problems.append(str(e))
        if problems:
            raise Stop('\n'.join(problems))
        confirmed = live_tip(cwd)
        if confirmed != tip:
            raise Stop(f'Remote advanced or changed between checks: {tip} -> {confirmed}. Repeat the review.')
        final_head, final_shallow, late_problems = local_state(cwd, project, quiet=True)
        if (final_head, final_shallow) != (head, shallow) or late_problems:
            raise Stop(f'Local state changed during verification (HEAD {head} -> {final_head}). '
                       + ' '.join(late_problems) + ' Stop concurrent work and rerun.')
        mode = 'startup' if publication is None else 'publication-candidate'
        print(f'PASS: {mode} remote={tip} HEAD={head} ({"equal" if head == tip else "verified descendant"}). '
              'No write, commit or push authorized.')
        return 0
    except Stop as e:
        print(f'STOP: {e}')
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        print('STOP: Required filesystem, process or remote check unavailable; details withheld.')
    print('Do not edit or publish. No recovery action was taken.')
    return 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publication', nargs=2, metavar=('REVIEWED_REMOTE_SHA', 'REVIEWED_HEAD_SHA'),
                        help='validate this exact reviewed pair as a candidate; never commit or push')
    pair = parser.parse_args().publication
    if pair and not all(OID.fullmatch(x) for x in pair):
        parser.error('publication verification requires two full lowercase commit SHAs')
    raise SystemExit(preflight(Path.cwd(), KARTA, pair))
