"""Provisioning regressions; no root, system users, or installed services touched."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('shared_projects', 'scripts/shared-projects.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


class SharedProjectsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='relay-projects-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / 'agent.json'
        self.state = self.root / 'private'
        self.state.mkdir()
        self.lock = self.root / 'shared-locks'
        self.original = {'roots': ['/home/example'], 'stateDir': str(self.state),
                         'socketPath': '/existing/socket', 'taskUmask': '0022', 'sensitivePaths': ['/private']}
        self.config.write_text(json.dumps(self.original))

    def config_run(self, apply=False):
        return subprocess.run(['python3', '-c', shared.USER_CONFIG, str(self.config), str(self.lock),
                               'apply' if apply else 'preview'], capture_output=True, text=True)

    def test_preview_apply_backup_preserves_other_fields_and_rerun_is_idempotent(self):
        original = self.config.read_bytes()
        preview = self.config_run()
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertEqual(self.config.read_bytes(), original)
        self.assertFalse(list(self.root.glob('*.before-*')))
        applied = self.config_run(True)
        self.assertEqual(applied.returncode, 0, applied.stderr)
        desired = json.loads(self.config.read_text())
        self.assertEqual(desired['roots'], ['/home/example', '/srv/projects'])
        self.assertEqual(desired['sharedLockDirectory'], str(self.lock))
        self.assertEqual(desired['taskUmask'], '0002')
        self.assertEqual(desired['sensitivePaths'], ['/private'])
        self.assertEqual(desired['socketPath'], '/existing/socket')
        backups = list(self.root.glob('*.before-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.config_run(True).returncode, 0)
        self.assertEqual(len(list(self.root.glob('*.before-*'))), 1)

    def test_named_account_queued_task_blocks_migration(self):
        database = self.state / 'accounts/example/state/agent.sqlite'
        database.parent.mkdir(parents=True)
        with sqlite3.connect(database) as db:
            db.execute('CREATE TABLE objects (kind TEXT, data TEXT)')
            db.execute('INSERT INTO objects VALUES (?, ?)', ('run', '{"state":"queued"}'))
        result = self.config_run(True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Active/queued', result.stderr)
        self.assertEqual(json.loads(self.config.read_text()), self.original)

    def test_uncertain_lease_is_never_erased(self):
        old = self.state / 'locks'
        old.mkdir()
        lease = old / 'unknown.lease'
        lease.write_text('uncertain')
        result = self.config_run(True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('lease records', result.stderr)
        self.assertEqual(lease.read_text(), 'uncertain')
        self.assertEqual(json.loads(self.config.read_text()), self.original)

    def test_config_symlink_is_refused(self):
        target = self.root / 'target'
        self.config.rename(target)
        self.config.symlink_to(target)
        result = self.config_run(True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(target.read_text()), self.original)

    def test_live_service_blocks_before_any_mutation(self):
        calls = []
        def run(*args, **kwargs):
            calls.append(args)
            return SimpleNamespace(stdout='active\n')
        with patch.object(shared, 'instances', return_value=[{'user': 'example'}]), \
             patch.object(shared, 'trusted_directory'), patch.object(shared, 'inspect_locks'), \
             patch.object(shared, 'config_operation', return_value='preview') as config, \
             patch.object(shared, 'run', side_effect=run):
            with self.assertRaisesRegex(ValueError, 'Stop every'):
                shared.configure(True)
            self.assertEqual(config.call_count, 1)
            self.assertEqual([x[0] for x in calls], ['systemctl'])

    def test_create_preview_and_apply_use_project_group_acl_and_append_memberships(self):
        parent = self.root / 'projects'
        parent.mkdir()
        calls = []
        lookups = [KeyError('missing'), SimpleNamespace(gr_gid=os.getgid())]
        with patch.object(shared, 'PROJECTS', parent), patch.object(shared, 'trusted_directory'), \
             patch.object(shared, 'user'), patch.object(shared.shutil, 'which', return_value='/setfacl'), \
             patch.object(shared.grp, 'getgrnam', side_effect=lookups), \
             patch.object(shared, 'run', side_effect=lambda *args, **kwargs: calls.append(args)), \
             patch.object(shared.os, 'chown'):
            shared.create_project('demo', ['example', 'example', 'another'], True)
        self.assertEqual((parent / 'demo').stat().st_mode & 0o7777, 0o2770)
        self.assertEqual(calls[0], ('groupadd', '--system', 'project-demo'))
        self.assertEqual(calls[1][0], 'setfacl')
        self.assertIn('d:o::---', calls[1][2])
        self.assertEqual(calls[2:], [('usermod', '-a', '-G', 'project-demo', 'example'),
                                    ('usermod', '-a', '-G', 'project-demo', 'another')])
        with patch.object(shared, 'PROJECTS', parent), patch.object(shared, 'trusted_directory'), \
             patch.object(shared, 'user'), patch.object(shared.shutil, 'which', return_value='/setfacl'), \
             patch.object(shared.grp, 'getgrnam', side_effect=KeyError), patch.object(shared, 'run') as run:
            shared.create_project('preview', ['example'], False)
            run.assert_not_called()
            self.assertFalse((parent / 'preview').exists())
            with self.assertRaisesRegex(ValueError, 'never overwritten'):
                shared.create_project('demo', ['example'], True)

    def test_project_path_traversal_is_rejected(self):
        for name in ('../escape', '/root', '.', 'a/b', '--flag', 'x' * 25):
            with self.assertRaises(ValueError):
                shared.create_project(name, ['example'], True)


if __name__ == '__main__':
    unittest.main()
