"""Synthetic publication and archive boundary regressions; no external services."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.email', 'test@example.com')
        self.git('config', 'user.name', 'Synthetic Test')
        self.commit('base')
        self.git('branch', 'baseline')

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.repo, text=True)

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-q', '--allow-empty', '-m', message)

    def check(self, event=None):
        env = dict(os.environ)
        env.pop('GITHUB_EVENT_PATH', None)
        if event:
            file = self.repo / '.event.json'
            file.write_text(json.dumps(event))
            env['GITHUB_EVENT_PATH'] = str(file)
        return subprocess.run(['python3', str(ROOT / 'scripts/check_publication.py'), 'baseline'], cwd=self.repo, env=env, capture_output=True, text=True).returncode

    def test_commit_identity_is_checked(self):
        self.git('-c', 'user.name=' + 'MET' + '-123', 'commit', '-q', '--allow-empty', '-m', 'ordinary change')
        self.assertEqual(self.check(), 1)

    def test_clean_control(self):
        (self.repo / 'example.txt').write_text('ordinary text\n')
        self.commit('ordinary change')
        self.assertEqual(self.check(), 0)

    def test_local_and_pr_branch(self):
        private = 'topic/' + 'MET' + '-123'
        self.git('checkout', '-q', '-b', private)
        self.assertEqual(self.check(), 1)
        self.git('checkout', '-q', 'main')
        self.assertEqual(self.check({'pull_request': {'head': {'ref': private}}}), 1)

    def test_added_plus_prefix_and_removed_intermediate(self):
        (self.repo / 'example.txt').write_text('++' + 'MET' + '-123\n')
        self.commit('introduce text')
        self.assertEqual(self.check(), 1)
        (self.repo / 'example.txt').write_text('ordinary text\n')
        self.commit('remove text')
        self.assertEqual(self.check(), 1)

    def test_private_filename(self):
        (self.repo / ('MET' + '-123.txt')).write_text('ordinary text\n')
        self.commit('add file')
        self.assertEqual(self.check(), 1)

    def test_wide_character_text_cannot_hide_content(self):
        for encoding in ('utf-16', 'utf-16-le', 'utf-16-be', 'utf-32', 'utf-32-le', 'utf-32-be'):
            with self.subTest(encoding=encoding):
                self.git('reset', '--hard', 'baseline')
                (self.repo / 'payload.txt').write_bytes(('MET' + '-123\n').encode(encoding))
                self.commit('add encoded text')
                self.assertEqual(self.check(), 1)

    def test_binary_attribute_cannot_hide_content(self):
        (self.repo / '.gitattributes').write_text('payload.txt -diff\n')
        (self.repo / 'payload.txt').write_bytes(b'binary\0' + b'MET' + b'-123\n')
        self.commit('add data')
        self.assertEqual(self.check(), 1)



if __name__ == "__main__":
    unittest.main()
