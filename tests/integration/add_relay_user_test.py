"""Test provisioning without root or installed service mutations."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('add_relay_user', 'scripts/add-relay-user.py')
add = importlib.util.module_from_spec(spec)
spec.loader.exec_module(add)


class AddUserTests(unittest.TestCase):
    def settings(self):
        return dict(host='192.168.10.20', port=4080, tailscaleHost='100.64.0.10',
                    trustedProxyIps=['100.64.0.20'], tailscaleProxyOrigin='https://remote.example.test:14080')

    def test_network_settings_inherit_only_valid_explicit_proxy(self):
        result = add.validate_network(self.settings(), {})
        self.assertEqual(result, ('192.168.10.20', '100.64.0.10', 'remote.example.test', ['100.64.0.20']))
        for key, bad in [('host', '0.0.0.0'), ('tailscaleHost', '8.8.8.8'),
                         ('trustedProxyIps', []), ('trustedProxyIps', ['*']),
                         ('tailscaleProxyOrigin', 'http://example.test'),
                         ('tailscaleProxyOrigin', 'https://user:password@example.test')]:
            value = self.settings()
            value[key] = bad
            with self.assertRaises((ValueError, TypeError)):
                add.validate_network(value, {})

    def test_auto_port_skips_reserved_backend_public_and_listener_ports(self):
        with patch.object(add, 'free_port', side_effect=lambda p: p != 4082):
            self.assertEqual(add.choose_port(None, {4080}, {14081}), 4083)
            with self.assertRaises(ValueError):
                add.choose_port(4082, set(), set())
        for p in (1, 65536, 55536):
            with self.assertRaises(ValueError):
                add.choose_port(p, set(), set())
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            self.assertFalse(add.free_port(listener.getsockname()[1]))

    def test_nginx_fragment_overwrites_forwarded_ip_and_limits_login(self):
        text = add.nginx_config('remote.example.test', '100.64.0.10', 4085)
        self.assertIn('listen 14085 ssl;', text)
        self.assertIn('proxy_pass http://100.64.0.10:4085;', text)
        self.assertIn('X-Forwarded-For $remote_addr;', text)
        self.assertIn('limit_req zone=relay_login', text)
        self.assertIn('proxy_buffering off;', text)
        self.assertNotIn('proxy_add_x_forwarded_for', text)

    def exercise(self, apply=False, duplicate=False):
        with tempfile.TemporaryDirectory() as temporary, contextlib.ExitStack() as stack:
            root = Path(temporary)
            unit = root / 'relay@.service'
            helper = root / 'helper'
            unit.write_text(add.service.MARKER)
            helper.write_text(add.service.MARKER)
            locks = root / 'locks'
            locks.mkdir(mode=0o2770)
            locks.chmod(0o2770)
            for module, key, value in [(add.service, 'UNIT', unit), (add.service, 'HELPER', helper),
                                       (add.shared, 'LOCKS', locks)]:
                stack.enter_context(patch.object(module, key, value))
            stack.enter_context(patch.object(add.os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(add.service, 'account', return_value=SimpleNamespace(pw_dir=str(root / 'alice'))))
            stack.enter_context(patch.object(add.service, 'trusted_json', return_value={'source': str(root), 'buildUser': 'operator'}))
            registrations = [{'user': 'operator'}, {'user': 'user1'}] + ([{'user': 'alice'}] if duplicate else [])
            stack.enter_context(patch.object(add.shared, 'instances', return_value=registrations))
            stack.enter_context(patch.object(add, 'public_settings', return_value=self.settings()))
            stack.enter_context(patch.object(add, 'free_port', return_value=True))
            stack.enter_context(patch.object(add.shared.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=os.getgid())))
            stack.enter_context(patch.object(add.shared, 'trusted_directory'))
            command = stack.enter_context(patch.object(add.service, 'user_command'))
            system = stack.enter_context(patch.object(add.subprocess, 'run', return_value=SimpleNamespace(stdout='inactive\n')))
            install = stack.enter_context(patch.object(add.service, 'install'))
            publish = stack.enter_context(patch.object(add.service, 'publish', return_value=root / 'release'))
            stack.enter_context(patch.object(add.service, 'build_lock', return_value=contextlib.nullcontext()))
            write = stack.enter_context(patch.object(add.service, 'atomic_write'))
            with contextlib.redirect_stdout(io.StringIO()):
                if duplicate:
                    with self.assertRaisesRegex(ValueError, 'already registered'):
                        add.add(SimpleNamespace(user='alice', reference=None, port=None, apply=apply))
                else:
                    add.add(SimpleNamespace(user='alice', reference=None, port=None, apply=apply))
            if duplicate or not apply:
                install.assert_not_called()
                publish.assert_not_called()
                write.assert_not_called()
                self.assertFalse(any(c.args[0][0] == 'usermod' for c in system.call_args_list))
            else:
                self.assertEqual(install.call_args.args[0].users, ['alice'])
                self.assertEqual(install.call_args.args[0].public_host, 'remote.example.test')
                self.assertEqual(install.call_args.args[0].port_offset, 10000)
                setup = command.call_args_list[-1]
                options = json.loads(setup.kwargs['extra_env']['RELAY_SETUP_OPTIONS'])
                self.assertEqual(options, {'sharedProjects': True, 'trustedProxyIps': ['100.64.0.20']})
                self.assertEqual(setup.args[0], 'alice')
                self.assertEqual(write.call_count, 1)
                self.assertFalse(any('code-server' in str(c) for c in system.call_args_list))

    def test_preview_performs_no_provisioning(self):
        self.exercise()

    def test_apply_installs_only_the_new_user_and_preserves_code_server(self):
        self.exercise(apply=True)

    def test_existing_registration_never_rotates_credentials(self):
        self.exercise(apply=True, duplicate=True)


if __name__ == '__main__':
    unittest.main()
