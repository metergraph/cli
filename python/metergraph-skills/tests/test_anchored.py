"""Deterministic ancestor replacement tests for retained directory handles."""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'src'))
from metergraph_skills import installer as subject


@unittest.skipUnless(os.name == 'posix', 'POSIX descriptor backend')
class AnchoredTest(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.project = self.base / 'project'
        self.outside = self.base / 'outside'
        self.project.mkdir()
        self.outside.mkdir()

    def run_install(self):
        return subject.run_skill('install', 'codex', 'local', str(self.project))

    def test_directory_swapped_before_temp_creation(self):
        original = subject._replace_file
        def swap(dest, content, previous):
            if dest[1] == 'SKILL.md':
                (self.project / '.agents').rename(self.project / 'retained')
                (self.project / '.agents').symlink_to(self.outside, target_is_directory=True)
            return original(dest, content, previous)
        with patch.object(subject, '_replace_file', side_effect=swap):
            self.assertEqual(self.run_install()['outcome'], 'ok')
        self.assertEqual(list(self.outside.iterdir()), [])
        self.assertTrue((self.project / 'retained/skills/metergraph/SKILL.md').is_file())

    def test_receipt_directory_swapped_before_lock(self):
        original = subject._acquire_lock
        def swap(dest):
            (self.project / '.metergraph').rename(self.project / 'retained')
            (self.project / '.metergraph').symlink_to(self.outside, target_is_directory=True)
            original(dest)
        with patch.object(subject, '_acquire_lock', side_effect=swap):
            self.assertEqual(self.run_install()['outcome'], 'ok')
        self.assertEqual(list(self.outside.iterdir()), [])
        self.assertFalse((self.project / 'retained/skill-installations.lock').exists())
        self.assertTrue((self.project / 'retained/skill-installations.json').is_file())

    def test_rollback_uses_retained_directory(self):
        original = subject._replace_file
        def fail_receipt(dest, content, previous):
            if dest[1] == subject.RECEIPT_FILE:
                (self.project / '.agents').rename(self.project / 'retained')
                (self.project / '.agents').symlink_to(self.outside, target_is_directory=True)
                (self.outside / 'SKILL.md').write_bytes(b'preserve')
                raise OSError('injected failure')
            return original(dest, content, previous)
        with patch.object(subject, '_replace_file', side_effect=fail_receipt):
            self.assertEqual(self.run_install()['reason'], 'write_failed')
        self.assertEqual((self.outside / 'SKILL.md').read_bytes(), b'preserve')
        self.assertFalse((self.project / 'retained/skills/metergraph/SKILL.md').exists())

    def test_symlink_substitution_before_component_open(self):
        original = os.mkdir
        def swap(name, *args, **kwargs):
            original(name, *args, **kwargs)
            if name == '.agents':
                (self.project / '.agents').rmdir()
                (self.project / '.agents').symlink_to(self.outside, target_is_directory=True)
        with patch.object(subject.os, 'mkdir', side_effect=swap):
            self.assertEqual(self.run_install()['reason'], 'unsafe_path')
        self.assertEqual(list(self.outside.iterdir()), [])

    def test_nonregular_read_does_not_block(self):
        meta = self.project / '.metergraph'
        meta.mkdir()
        os.mkfifo(meta / subject.RECEIPT_FILE)
        self.assertEqual(self.run_install()['reason'], 'unsafe_path')

    def test_unavailable_backend_writes_nothing(self):
        with patch.object(subject.os, 'name', 'nt'):
            self.assertEqual(self.run_install()['reason'], 'secure_filesystem_unavailable')
        self.assertEqual(list(self.project.iterdir()), [])

    def test_search_only_directories_preserve_install(self):
        self._assert_search_only_install()

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin legacy CPython compatibility')
    def test_search_only_install_without_python_search_flag_symbols(self):
        # CPython 3.9 on macOS does not export O_SEARCH or O_PATH. Exercise
        # that selection independently of the interpreter running this test.
        legacy_flags = SimpleNamespace(O_RDONLY=os.O_RDONLY)
        access = subject._directory_access(legacy_flags, 'darwin')
        with patch.object(subject, 'DIRECTORY_ACCESS', access):
            self._assert_search_only_install()

    def _assert_search_only_install(self):
        # Each case makes the project, a project ancestor, or the existing
        # client directory writable/searchable without directory listing.
        for restricted in ('project', 'ancestor', 'client'):
            with self.subTest(restricted=restricted):
                parent = self.base / ('restricted-' + restricted)
                parent.mkdir()
                project = parent / 'project'
                project.mkdir()
                client = project / '.agents'
                client.mkdir()
                directory = {'project': project, 'ancestor': parent, 'client': client}[restricted]
                directory.chmod(0o333)
                try:
                    result = subject.run_skill('install', 'codex', 'local', str(project))
                    self.assertEqual(result['outcome'], 'ok', result)
                    self.assertEqual((project / '.agents/skills/metergraph/SKILL.md').read_bytes(),
                                     subject.load_bundled_skill().content)
                finally:
                    directory.chmod(0o755)
