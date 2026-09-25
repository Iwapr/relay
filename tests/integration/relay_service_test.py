"""Publication tests run without root or touching installed services."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('relay_service', 'scripts/relay-service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='relay-publish-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = root / 'source'
        self.source.mkdir()
        for key, value in [('CODE', root / 'code'), ('STATE', root / 'state'), ('CONFIG', root / 'config')]:
            p = patch.object(service, key, value)
            p.start()
            self.addCleanup(p.stop)
        service.STATE.mkdir()
        for name in service.PROGRAM_DIRS:
            (self.source / name).mkdir()
        (self.source / 'apps/main.ts').write_text('version one')
        for name in service.PROGRAM_FILES:
            (self.source / name).write_text('{}')
        (self.source / 'generated/manifest.json').write_text('{"codexVersion":"1.0"}')
        binary = self.source / '.runtime/codex/1.0/codex'
        binary.parent.mkdir(parents=True)
        binary.write_text('binary')
        binary.chmod(0o700)
        (self.source / '.runtime/login.txt').write_text('secret password')
        modules = self.source / 'node_modules'
        (modules / '.bin').mkdir(parents=True)
        (modules / 'tsx').write_text('dependency')
        (modules / '.bin/tsx').symlink_to('../tsx')
        self.config = {'source': str(self.source), 'buildUser': pwd.getpwuid(os.getuid()).pw_name, 'npm': '/npm'}
        self.builds = 0

    def build(self, *args, **kwargs):
        self.builds += 1
        dist = self.source / 'apps/web/dist'
        dist.mkdir(parents=True, exist_ok=True)
        (dist / 'index.html').write_text('compiled')
        return subprocess.CompletedProcess([], 0)

    def test_publish_cache_isolation_and_failed_update(self):
        with patch.object(service, 'user_command', side_effect=self.build):
            first = service.publish(self.config)
            service.pin_instance('one', first)
            service.pin_instance('two', first)
            self.assertEqual(service.publish(self.config), first)
            self.assertEqual(self.builds, 1)
            self.assertFalse((first / '.runtime').exists())
            self.assertEqual((first / 'codex/codex').stat().st_mode & 0o777, 0o755)
            self.assertEqual((first / 'apps/main.ts').stat().st_mode & 0o777, 0o644)
            (self.source / 'apps/main.ts').write_text('version two')
            second = service.publish(self.config)
            service.pin_instance('one', second)
            self.assertNotEqual(first, second)
            self.assertEqual((first / 'apps/main.ts').read_text(), 'version one')
            self.assertEqual((service.STATE / 'instances/two.release').read_text().strip(), str(first))
            self.assertEqual((first / 'node_modules').resolve(), (second / 'node_modules').resolve())
        (self.source / 'apps/main.ts').write_text('bad version')
        with patch.object(service, 'user_command', side_effect=RuntimeError('build failed')):
            with self.assertRaisesRegex(RuntimeError, 'build failed'):
                service.publish(self.config)
        self.assertEqual((service.STATE / 'instances/one.release').read_text().strip(), str(second))

    def test_published_dependencies_resolve_transitive_node_imports(self):
        modules = self.source / 'node_modules'
        for name, code in [('outer', "import value from 'inner'; export default value;"),
                           ('inner', 'export default 42;')]:
            directory = modules / name
            directory.mkdir()
            (directory / 'package.json').write_text('{"type":"module","exports":"./index.js"}')
            (directory / 'index.js').write_text(code)
        with patch.object(service, 'user_command', side_effect=self.build):
            release = service.publish(self.config)
        result = subprocess.run(['node', '--input-type=module', '--eval',
                                 "import value from 'outer'; if (value !== 42) process.exit(1)"],
                                cwd=release, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_dependency_changes_and_concurrent_edit(self):
        with patch.object(service, 'user_command', side_effect=self.build):
            service.publish(self.config)
            (self.source / 'package-lock.json').write_text('{"changed":true}')
            service.publish(self.config)
            self.assertEqual(self.builds, 3)  # initial build, npm ci, updated build
        (self.source / 'apps/main.ts').write_text('three')
        def racing_build(*args, **kwargs):
            self.build()
            (self.source / 'apps/main.ts').write_text('four')
        with patch.object(service, 'user_command', side_effect=racing_build):
            with self.assertRaisesRegex(RuntimeError, 'Source changed'):
                service.publish(self.config)

    def test_escaping_symlink_is_rejected(self):
        (self.source / 'apps/escape').symlink_to('/etc/passwd')
        with patch.object(service, 'user_command', side_effect=self.build):
            with self.assertRaisesRegex(ValueError, 'escapes'):
                service.publish(self.config)

    def test_node_gyp_build_cache_is_omitted_but_compiled_addons_are_published(self):
        build = self.source / 'node_modules/node-pty/build'
        cache = build / 'node_gyp_bins'
        cache.mkdir(parents=True)
        cache.joinpath('python3').symlink_to('/usr/bin/python3')
        addon = build / 'Release/pty.node'
        addon.parent.mkdir()
        addon.write_bytes(b'compiled addon')
        with patch.object(service, 'user_command', side_effect=self.build):
            release = service.publish(self.config)
        published = release / 'node_modules/node-pty/build'
        self.assertFalse((published / 'node_gyp_bins').exists())
        self.assertEqual((published / 'Release/pty.node').read_bytes(), b'compiled addon')
        self.assertTrue(cache.joinpath('python3').is_symlink())

    def test_dependency_runtime_links_must_still_stay_inside_the_package(self):
        (self.source / 'node_modules/runtime-escape').symlink_to('/usr/bin/python3')
        with patch.object(service, 'user_command', side_effect=self.build):
            with self.assertRaisesRegex(ValueError, 'escapes'):
                service.publish(self.config)

    def test_failed_migration_restores_legacy_services_and_configuration(self):
        from types import SimpleNamespace
        name = self.config['buildUser']
        home = self.source / 'home'
        old_dir = home / '.config/systemd/user'
        old_dir.mkdir(parents=True)
        for unit in service.COMPONENTS:
            (old_dir / unit).write_text(service.OLD_MARKER + '\n')
        template = self.source / 'deploy/systemd/relay@.service'
        template.parent.mkdir(parents=True)
        template.write_text(service.MARKER + '\n')
        node = service.CODE / 'node/bin/node'
        node.parent.mkdir(parents=True)
        node.write_text('runtime')
        descriptor = {'user': name, 'agentConfig': '/private/agent.json', 'gatewayConfig': '/private/gateway.json'}
        calls = []
        def system_command(argv, **kwargs):
            calls.append(argv)
            if argv == ['systemctl', 'restart', f'relay@{name}.service']:
                raise subprocess.CalledProcessError(1, argv)
            if len(argv) > 1 and argv[1] in ('is-active', 'is-enabled'):
                return subprocess.CompletedProcess(argv, 1)
            return subprocess.CompletedProcess(argv, 0)
        def user_command(user, argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0)
        helper = self.source / 'installed-helper'
        unit_path = self.source / 'installed-unit'
        group_path = self.source / 'installed-group-unit'
        prior = {'source': '/previous/source'}
        service.write_json(service.CONFIG / 'source.json', prior)
        args = SimpleNamespace(source=self.source, users=[name], public_host=None, port_offset=10000)
        user = SimpleNamespace(pw_uid=os.getuid(), pw_dir=str(home))
        with patch.object(service, 'HELPER', helper), patch.object(service, 'UNIT', unit_path), \
             patch.object(service, 'GROUP_UNIT', group_path), \
             patch.object(service, 'account', return_value=user), \
             patch.object(service, 'locate_instance', return_value=descriptor), \
             patch.object(service, 'ensure_idle'), patch.object(service, 'check_instance'), \
             patch.object(service, 'publish', return_value=service.CODE / 'releases/test'), \
             patch.object(service, 'user_command', side_effect=user_command), \
             patch.object(service.subprocess, 'run', side_effect=system_command):
            with self.assertRaises(subprocess.CalledProcessError):
                service.install(args)
        self.assertEqual(json.loads((service.CONFIG / 'source.json').read_text()), prior)
        self.assertFalse(helper.exists())
        self.assertFalse(unit_path.exists())
        self.assertFalse(group_path.exists())
        self.assertFalse((service.CONFIG / 'instances' / (name + '.json')).exists())
        for old in service.COMPONENTS:
            self.assertIn(['systemctl', '--user', 'start', old], calls)
            self.assertIn(['systemctl', '--user', 'enable', old], calls)

    def test_systemd_parses_group_and_instance_dependencies(self):
        user = self.config['buildUser']
        group = self.source / 'relay.service'
        group.write_text(service.group_unit_text([user]))
        template = self.source / 'relay@.service'
        template.write_text(Path('deploy/systemd/relay@.service').read_text().replace(
            '/usr/local/libexec/relay-service', '/usr/bin/python3'))
        result = subprocess.run(['systemd-analyze', 'verify', str(group), str(template)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with self.assertRaises(ValueError):
            service.group_unit_text(['invalid\nExecStart=bad'])

    def test_install_group_upgrades_existing_units_without_restarting_and_rolls_back_errors(self):
        name = self.config['buildUser']
        instances = service.CONFIG / 'instances'
        instances.mkdir(parents=True)
        (instances / (name + '.json')).write_text(json.dumps({'user': name}))
        unit = self.source / 'system/relay@.service'
        unit.parent.mkdir()
        original = Path('deploy/systemd/relay@.service').read_text().replace('PartOf=relay.service\n', '')
        unit.write_text(original)
        group = unit.parent / 'relay.service'
        dropin = unit.parent / 'relay@.service.d/relay-group.conf'
        calls = []
        def command(argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 1 if argv[1] == 'is-enabled' else 0)
        with patch.object(service, 'UNIT', unit), patch.object(service, 'GROUP_UNIT', group), \
             patch.object(service, 'trusted_json', side_effect=lambda path: json.loads(path.read_text())), \
             patch.object(service.subprocess, 'run', side_effect=command), \
             patch.object(service, 'publish') as publish, patch.object(service, 'ensure_idle') as idle:
            service.install_group()
            service.install_group()
            self.assertEqual(unit.read_text(), original)
            self.assertIn('PartOf=relay.service', dropin.read_text())
            self.assertIn(f'Wants=relay@{name}.service', group.read_text())
            self.assertIn(['systemctl', 'enable', 'relay.service'], calls)
            self.assertIn(['systemctl', 'daemon-reload'], calls)
            self.assertFalse(any(c[0] == 'systemctl' and any(x in c for x in ('start', 'stop', 'restart', '--now')) for c in calls))
            publish.assert_not_called()
            idle.assert_not_called()
            before = (group.read_text(), dropin.read_text())
            def fail_enable(argv, **kwargs):
                if argv == ['systemctl', 'enable', 'relay.service']:
                    raise subprocess.CalledProcessError(1, argv)
                return command(argv, **kwargs)
            with patch.object(service.subprocess, 'run', side_effect=fail_enable):
                with self.assertRaises(subprocess.CalledProcessError):
                    service.install_group()
            self.assertEqual((group.read_text(), dropin.read_text()), before)
            group.write_text('unrelated unit\n')
            with self.assertRaisesRegex(ValueError, 'unrelated'):
                service.install_group()

    def test_active_run_blocks_migration(self):
        agent = self.source / 'agent.json'
        agent.write_text(json.dumps({'stateDir': str(self.source)}))
        descriptor = {'user': 'example', 'agentConfig': str(agent)}
        with sqlite3.connect(self.source / 'agent.sqlite') as db:
            db.execute('CREATE TABLE objects(kind TEXT, data TEXT)')
            db.execute('INSERT INTO objects VALUES (?, ?)', ('run', '{"state":"running"}'))
        with self.assertRaisesRegex(RuntimeError, 'active or queued'):
            service.ensure_idle(descriptor)
        with sqlite3.connect(self.source / 'agent.sqlite') as db:
            db.execute('UPDATE objects SET data=?', ('{"state":"completed"}',))
        service.ensure_idle(descriptor)


if __name__ == '__main__':
    unittest.main()
