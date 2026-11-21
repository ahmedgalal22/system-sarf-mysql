"""Offline integration tests. Only Git repositories under a fresh /tmp directory are used."""
from contextlib import redirect_stdout
import hashlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import git_preflight as gate


def snapshot(root):
    """Include directories, modes, symlinks and bytes, even ignored files and all of .git."""
    records = {}
    for p in root.rglob('*'):
        if p.is_symlink():
            data = os.fsencode(os.readlink(p))
        else:
            data = p.read_bytes() if p.is_file() else b''
        st = p.lstat()
        records[str(p.relative_to(root))] = (st.st_mode, st.st_mtime_ns, hashlib.sha256(data).digest())
    return records


class PreflightTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='karta-preflight-', dir='/tmp')
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        env = dict(PATH=os.environ['PATH'], HOME=tmp.name, XDG_CONFIG_HOME=tmp.name,
                   LC_ALL='C', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_TERMINAL_PROMPT='0', GIT_ALLOW_PROTOCOL='file',
                   GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                   GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid')
        sandbox_env = patch.dict(os.environ, env, clear=True)
        sandbox_env.start()
        self.addCleanup(sandbox_env.stop)
        self.origin = self.tmp / 'origin'
        self.origin.mkdir()
        self.git(self.origin, 'init', '-q', '--template=', '-b', gate.BRANCH)
        self.base = self.commit(self.origin, 'karta/seed', 'base\n')
        self.work = self.clone('work')
        self.project = gate.Project(self.work, self.origin.as_uri(), self.base)

    def git(self, repo, *args):
        repo.resolve().relative_to(self.tmp)  # refuse fixture commands anywhere else
        p = subprocess.run(['git', '-c', 'core.hooksPath=' + os.devnull, *args], cwd=repo,
                           capture_output=True, check=True, stdin=subprocess.DEVNULL, timeout=10)
        return p.stdout.decode().strip()

    def commit(self, repo, name, data):
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data)
        self.git(repo, 'add', '--', name)
        self.git(repo, 'commit', '-qm', name)
        return self.git(repo, 'rev-parse', 'HEAD')

    def clone(self, name, *options):
        self.git(self.tmp, 'clone', '-q', '--template=', '--single-branch', '--no-tags',
                 '--branch', gate.BRANCH, *options, self.origin.as_uri(), name)
        return self.tmp / name

    def preload(self, *options):
        # Fixture setup only. Supply objects WITHOUT refreshing its stale tracking ref.
        self.git(self.work, 'fetch', '--no-tags', '--refmap=', *options, 'origin', gate.REF)

    def check(self, *messages, passes=False, publication=None, moving_origin=False, cwd=None):
        local_before, remote_before = snapshot(self.work), snapshot(self.origin)
        out = io.StringIO()
        with redirect_stdout(out):
            code = gate.preflight(cwd or self.work, self.project, publication)
        self.assertEqual(local_before, snapshot(self.work), 'local .git or working files changed')
        if not moving_origin:
            self.assertEqual(remote_before, snapshot(self.origin), 'origin changed')
        report = out.getvalue()
        self.assertEqual(code, 0 if passes else 1, report)
        self.assertIn('PASS:' if passes else 'STOP:', report)
        for message in messages:
            self.assertIn(message, report)
        return report

    def faulty_response(self, words, *messages, stdout=None, stderr=b'', occurrence=1):
        """Inject a bad response at the pipe boundary, not inside the verifier's parser."""
        run = subprocess.run
        hits = []

        def altered(cmd, **kwargs):
            p = run(cmd, **kwargs)
            if any(tuple(cmd[i:i + len(words)]) == words for i in range(len(cmd))):
                hits.append(True)
                if len(hits) == occurrence:
                    self.assertEqual(p.returncode, 0)
                    return subprocess.CompletedProcess(cmd, 0, p.stdout if stdout is None else stdout, stderr)
            return p

        with patch.object(subprocess, 'run', altered):
            report = self.check(*messages)
        self.assertGreaterEqual(len(hits), occurrence)
        self.assertNotIn('PRIVATE_SENTINEL', report)
        self.assertNotIn('PASS:', report)

    def test_matching_tip(self):
        self.check('Git status', '(clean)', f'PASS: startup remote={self.base} HEAD={self.base}', passes=True)

    def test_verified_descendant_without_upstream(self):
        ahead = self.commit(self.work, 'local', 'reviewed\n')
        self.git(self.work, 'config', '--remove-section', 'branch.' + gate.BRANCH)
        self.check('upstream: (none)', 'PASS: startup', 'verified descendant', ahead,
                   'No write, commit or push authorized', passes=True)

    def test_multiple_commits_ahead_is_valid_startup_not_publication(self):
        self.commit(self.work, 'one', 'one\n')
        two = self.commit(self.work, 'two', 'two\n')
        self.check(f'PASS: startup remote={self.base} HEAD={two}', 'verified descendant',
                   'No write, commit or push authorized', passes=True)
        self.assertEqual(self.git(self.origin, 'rev-parse', 'HEAD'), self.base)

    def test_provable_shallow_local_ahead_is_valid(self):
        self.work = self.clone('shallow-ahead', '--depth=1')
        self.project = self.project._replace(root=self.work)
        self.commit(self.work, 'local', 'one provable commit after the boundary\n')
        self.check('Shallow: true', 'PASS: startup', 'verified descendant', passes=True)

    def test_dirty_ahead_is_not_a_startup_baseline(self):
        ahead = self.commit(self.work, 'local', 'committed\n')
        (self.work / 'local').write_text('work in progress\n')
        self.check(ahead, ' M local', 'Preserve and review')

    def test_behind_despite_matching_stale_tracking_ref(self):
        tip = self.commit(self.origin, 'remote', 'advanced\n')
        self.preload()
        self.assertEqual(self.git(self.work, 'rev-parse', 'origin/' + gate.BRANCH), self.base)
        self.check(self.base, tip, 'HEAD is behind')

    def test_divergent(self):
        remote = self.commit(self.origin, 'remote', 'remote\n')
        local = self.commit(self.work, 'local', 'local\n')
        self.preload()
        self.check(remote, local, 'histories diverge')

    def test_wrong_branch(self):
        self.git(self.work, 'branch', '-m', 'main')
        with patch.object(gate, 'live_tip', side_effect=AssertionError('contacted origin')):
            self.check('Wrong branch', 'Branch: (other branch)', 'require ' + gate.REF, self.base, '(clean)')

    def test_wrong_root(self):
        self.check('Wrong root', 'No repository inspected', cwd=self.work / 'karta')

    def test_wrong_fetch_remote(self):
        self.git(self.work, 'remote', 'set-url', 'origin', (self.tmp / 'wrong').as_uri())
        with patch.object(gate, 'live_tip', side_effect=AssertionError('contacted wrong origin')):
            self.check('Wrong origin fetch URL', self.base, '(clean)')

    def test_extra_push_url(self):
        self.git(self.work, 'remote', 'set-url', '--add', '--push', 'origin', self.project.origin)
        self.git(self.work, 'remote', 'set-url', '--add', '--push', 'origin', (self.tmp / 'extra').as_uri())
        self.check('Wrong origin push URL', 'No remote contacted')

    def test_mirror_origin(self):
        self.git(self.work, 'config', 'remote.origin.mirror', 'true')
        self.check('Origin is configured as a mirror')

    def test_missing_remote_branch(self):
        self.git(self.origin, 'update-ref', '-d', gate.REF, self.base)
        self.check(gate.REF + ' is missing', 'no fallback')

    def test_missing_remote_object_does_not_fetch(self):
        tip = self.commit(self.origin, 'remote', 'unknown locally\n')
        self.check(f'No local commit object for live remote tip {tip}', 'Ancestry unproven')

    def test_insufficient_shallow_history_with_both_commits_present(self):
        self.work = self.clone('shallow', '--depth=1')
        tip = self.commit(self.origin, 'remote', 'new boundary\n')
        self.preload('--depth=1')
        self.project = self.project._replace(root=self.work, published_floor=tip)
        for oid in (self.base, tip):
            self.assertEqual(self.git(self.work, 'cat-file', '-t', oid), 'commit')
        report = self.check('Shallow: true', 'Insufficient shallow history', self.base, tip)
        self.assertNotIn('histories diverge', report)

    def test_staged(self):
        (self.work / 'karta/seed').write_text('staged\n')
        self.git(self.work, 'add', '--', 'karta/seed')
        self.check('M  karta/seed', 'Preserve and review')

    def test_unstaged(self):
        (self.work / 'karta/seed').write_text('unstaged\n')
        self.check(' M karta/seed', 'Preserve and review')

    def test_untracked(self):
        (self.work / 'user work').write_text('not yet tracked\n')
        self.check('?? "user work"', 'Preserve and review')

    def test_ignored(self):
        (self.work / '.git/info').mkdir(exist_ok=True)
        (self.work / '.git/info/exclude').write_text('private-note\n')
        (self.work / 'private-note').write_text('must survive\n')
        self.check('!! private-note', 'Preserve and review')

    def test_assume_unchanged_cannot_hide_work(self):
        self.git(self.work, 'update-index', '--assume-unchanged', 'karta/seed')
        (self.work / 'karta/seed').write_text('hidden user work\n')
        self.check('assume-unchanged paths')

    def test_split_index_refused_without_refresh(self):
        self.git(self.work, 'update-index', '--split-index')
        self.check('Split-index metadata')

    def test_partial_clone_configuration_stops_before_object_access(self):
        self.git(self.work, 'config', 'remote.origin.promisor', 'true')
        with patch.object(gate, 'live_tip', side_effect=AssertionError('contacted origin')):
            self.check('Partial-clone configuration')

    def test_actual_merge_in_progress_even_with_clean_porcelain(self):
        side = self.git(self.work, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'fixture side')
        self.commit(self.work, 'local', 'local\n')
        self.git(self.work, 'merge', '--no-ff', '--no-commit', side)
        self.assertEqual(self.git(self.work, 'status', '--porcelain'), '')
        self.check('In-progress operation or lock: MERGE_HEAD')

    def test_operation_markers(self):
        for marker in ('rebase-apply', 'rebase-merge', 'sequencer', 'CHERRY_PICK_HEAD',
                       'REVERT_HEAD', 'BISECT_START', 'index.lock'):
            with self.subTest(marker=marker):
                p = self.work / '.git' / marker
                if marker in ('rebase-apply', 'rebase-merge', 'sequencer'):
                    p.mkdir()
                else:
                    p.write_text(self.base + '\n')
                self.check('In-progress operation or lock: ' + marker)
                if p.is_dir():
                    p.rmdir()
                else:
                    p.unlink()

    def test_success_with_diagnostics_is_not_a_complete_read(self):
        for words in (('status', '--porcelain=v1'), ('ls-files', '-v'),
                      ('ls-files', '--others', '--exclude-standard'), ('ls-files', '--others', '--ignored'),
                      ('ls-tree', '-r'), ('ls-remote', '--exit-code'), ('remote', 'get-url'),
                      ('rev-parse', '--path-format=absolute'), ('config', '--bool', '--get', 'core.filemode')):
            with self.subTest(command=words):
                self.faulty_response(words, 'unexpected diagnostics', stderr=b'warning: PRIVATE_SENTINEL\n')

    def test_malformed_or_truncated_inventories(self):
        for words, data, reason in (
                (('status', '--porcelain=v1'), b'?? file', 'NUL-delimited'),
                (('status', '--porcelain=v1'), b'?? \0', 'repository-relative path'),
                (('status', '--porcelain=v1'), b'XY PRIVATE_SENTINEL\0', 'Malformed porcelain'),
                (('ls-files', '-v'), b'H 100644 not-an-oid 0\tkarta/seed\0', 'index inventory'),
                (('ls-files', '--others', '--exclude-standard'), b'unfinished', 'NUL-delimited'),
                (('ls-files', '--others', '--ignored'), b'one\0\0', 'NUL-delimited'),
                (('ls-tree', '-r'), b'100644 blob broken\tname\0', 'tree inventory'),
                (('ls-remote', '--exit-code'), (self.base + '\t' + gate.REF).encode(), 'one complete SHA'),
                (('ls-remote', '--exit-code'), b'PRIVATE_SENTINEL\nextra\n', 'one complete SHA'),
                (('rev-parse', '--path-format=absolute'), b'/PRIVATE_SENTINEL\n', 'Unexpected resolved root'),
                (('for-each-ref',), b'\n', 'incomplete approved ref record'),
                (('config', '--bool', '--get', 'core.filemode'), b'true\nPRIVATE_SENTINEL\n', 'Malformed boolean')):
            with self.subTest(command=words, reason=reason):
                self.faulty_response(words, reason, stdout=data)

    def test_missing_whole_index_or_tree_record(self):
        for words in (('ls-files', '-v'), ('ls-tree', '-r')):
            with self.subTest(command=words):
                self.faulty_response(words, 'HEAD tree and index inventories disagree', stdout=b'')

    def test_other_and_ignored_listings_must_agree_with_status(self):
        (self.work / '.git/info').mkdir(exist_ok=True)
        (self.work / '.git/info/exclude').write_text('ignored\n')
        (self.work / 'ignored').touch()
        (self.work / 'other').touch()
        for words in (('ls-files', '--others', '--ignored'), ('ls-files', '--others', '--exclude-standard'),
                      ('status', '--porcelain=v1')):
            with self.subTest(command=words):
                self.faulty_response(words, 'Inconsistent untracked/ignored', stdout=b'')

    def test_disk_scan_catches_file_even_if_both_git_listings_omit_it(self):
        (self.work / 'unlisted').touch()
        # Model an apparently clean, internally consistent status/other/ignored inventory.
        with patch.object(gate, 'status_inventory', return_value=[]):
            self.check('Filesystem contains a path missing from the clean Git inventory')

    def test_filesystem_inventory_catches_omitted_deleted_or_changed_file(self):
        seed = self.work / 'karta/seed'
        seed.write_text('different bytes\n')
        self.faulty_response(('status', '--porcelain=v1'), 'Raw working bytes or Git mode differ', stdout=b'')
        seed.unlink()
        self.check(' D karta/seed', 'Preserve and review')
        self.faulty_response(('status', '--porcelain=v1'), 'Filesystem and tracked-path inventories disagree', stdout=b'')

    def test_unusual_names_and_symlink(self):
        name = os.fsdecode(b'space \tline\nbad-\xff')
        self.commit(self.work, name, 'tracked\n')
        (self.work / 'link').symlink_to('no target')
        self.git(self.work, 'add', '--', 'link')
        self.git(self.work, 'commit', '-qm', 'tracked link')
        self.check('verified descendant', passes=True)
        (self.work / name).write_text('changed\n')
        (self.work / 'extra\npath').touch()
        self.check(r' M "space \tline\nbad-\udcff"', r'?? "extra\npath"')

    def test_late_local_inventory_diagnostic_blocks_pass(self):
        self.faulty_response(('status', '--porcelain=v1'), 'unexpected diagnostics', occurrence=2,
                             stderr=b'PRIVATE_SENTINEL')

    def test_linked_worktree_and_shared_main_store(self):
        linked = self.tmp / 'linked'
        self.git(self.work, 'worktree', 'add', '-q', '--detach', str(linked), self.base)
        self.check('Linked/shared worktree metadata')
        self.project = self.project._replace(root=linked)
        before = snapshot(linked)
        self.check('Unsupported .git layout', cwd=linked)
        self.assertEqual(before, snapshot(linked))

    def test_redirected_or_symlinked_index(self):
        other = self.tmp / 'other-index'
        with patch.dict(os.environ, {'GIT_INDEX_FILE': str(other)}):
            self.check('redirection is active', 'no repository inspected')
        self.assertFalse(other.exists())
        index = self.work / '.git/index'
        index.rename(other)
        index.symlink_to(other)
        self.check('Symlinked Git storage')

    def test_unobservable_executable_bit_refused(self):
        self.git(self.work, 'config', 'core.filemode', 'false')
        (self.work / 'karta/seed').chmod(0o755)
        self.assertEqual(self.git(self.work, 'status', '--porcelain'), '')
        self.check('Require core.filemode=true')

    def test_executable_bit_change_is_dirty(self):
        (self.work / 'karta/seed').chmod(0o755)
        self.check(' M karta/seed', 'Preserve and review')
        self.faulty_response(('status', '--porcelain=v1'), 'Raw working bytes or Git mode differ', stdout=b'')

    def test_raw_bytes_not_just_normalized_git_status(self):
        self.commit(self.origin, '.gitattributes', 'karta/seed text eol=crlf\n')
        self.work = self.clone('crlf-work')  # let Git perform its normal checkout conversion
        self.project = self.project._replace(root=self.work)
        self.assertEqual((self.work / 'karta/seed').read_bytes(), b'base\r\n')
        self.assertEqual(self.git(self.work, 'status', '--porcelain'), '')
        self.check('Raw working bytes or Git mode differ')

    def test_unsupported_index_worktree_and_filter_config(self):
        for key, value, message in (('core.splitIndex', 'true', 'Unsupported core.splitIndex'),
                                    ('core.sparseCheckout', 'true', 'Unsupported core.sparseCheckout'),
                                    ('core.worktree', str(self.work), 'Worktree redirection'),
                                    ('filter.fixture.clean', 'cat', 'External filter'),
                                    ('filter.fixture.smudge', 'cat', 'External filter'),
                                    ('filter.fixture.process', 'cat', 'External filter')):
            with self.subTest(key=key):
                self.git(self.work, 'config', key, value)
                self.check(message)
                self.git(self.work, 'config', '--unset', key)

    def test_unsupported_history_and_object_storage(self):
        for rel in ('objects/info/alternates', 'objects/info/http-alternates', 'info/grafts',
                    'objects/pack/fixture.promisor'):
            with self.subTest(path=rel):
                p = self.work / '.git' / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.touch()
                self.check('Graft, alternate or promisor metadata')
                p.unlink()

    def test_config_fetch_and_ref_locks(self):
        for rel in ('config.lock', 'FETCH_HEAD.lock', 'packed-refs.lock', gate.REF + '.lock'):
            with self.subTest(path=rel):
                p = self.work / '.git' / rel
                p.touch()
                self.check('In-progress operation or lock: ' + rel)
                p.unlink()

    def test_remote_changes_between_two_real_advertisements(self):
        read = gate.live_tip
        observed = []

        def advance_after_first_read(cwd):
            observed.append(read(cwd))
            if len(observed) == 1:
                self.commit(self.origin, 'race', 'another publisher\n')
            return observed[-1]

        with patch.object(gate, 'live_tip', advance_after_first_read):
            report = self.check('changed between checks', moving_origin=True)
        self.assertEqual(observed, [self.base, self.git(self.origin, 'rev-parse', 'HEAD')])
        self.assertIn(' -> '.join(observed), report)

    def test_remote_behind_published_floor(self):
        known = self.commit(self.work, 'known', 'known publication\n')
        self.project = self.project._replace(published_floor=known)
        self.check('does not descend from published floor', known, self.base)

    def test_publication_requires_both_reviewed_shas(self):
        head = self.commit(self.work, 'reviewed', 'publish later\n')
        self.check('PASS: publication-candidate', 'verified descendant', 'No write, commit or push authorized',
                   passes=True, publication=(self.base, head))
        for stale in ((self.base, self.base), (head, head)):
            with self.subTest(stale=stale):
                self.check('Reviewed remote/HEAD pair', 'Stop and review again', publication=stale)


if __name__ == '__main__':
    unittest.main(verbosity=2)
