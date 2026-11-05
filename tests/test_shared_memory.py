import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import agentsui


class SharedMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.projects = Path(self.temp.name) / 'projects'
        patcher = patch.object(agentsui, 'PROJECTS', self.projects)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repo = Path(self.temp.name) / 'my.repo'
        (self.repo / 'sub').mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)

    def expected(self):
        root = Path(self.repo).resolve()
        return self.projects / agentsui.re.sub(r'[^A-Za-z0-9]', '-', str(root)) / 'memory'

    def test_codex_is_pointed_at_claude_memory_for_the_repo(self):
        plan = agentsui.plan_terminal('codex', str(self.repo / 'sub'), '')
        folder = self.expected()
        self.assertTrue(folder.is_dir())
        self.assertEqual(plan.argv[:5],
                         ['codex', '--sandbox', 'workspace-write', '--add-dir', str(folder)])
        self.assertEqual(plan.argv[5], '-c')
        key, value = plan.argv[6].split('=', 1)
        self.assertEqual(key, 'developer_instructions')
        self.assertIn(str(folder / 'MEMORY.md'), json.loads(value))

    def test_resumed_codex_gets_the_same_flags(self):
        detail = {'id': 'abc', 'agent': 'codex', 'cwd': str(self.repo), 'title': 't'}
        with patch.object(agentsui.BOARD, 'detail', return_value=detail):
            plan = agentsui.plan_terminal('claude', '', 'rollout.jsonl')
        self.assertEqual(plan.argv[:7], ['codex', 'resume', 'abc', '--sandbox',
                                        'workspace-write', '--add-dir', str(self.expected())])

    def test_claude_is_told_about_history_and_shell_is_unchanged(self):
        argv = agentsui.plan_terminal('claude', str(self.repo), '').argv
        self.assertEqual(argv[:2], ['claude', '--append-system-prompt'])
        self.assertIn('agentsui.py sessions', argv[2])
        self.assertEqual(agentsui.plan_terminal('shell', str(self.repo), '').argv,
                         agentsui.NEW['shell'])

    def test_history_finds_both_agents_in_the_project_only(self):
        root = str(Path(self.repo).resolve())
        codex = Path(self.temp.name) / 'codex'
        (codex / '2026').mkdir(parents=True)
        def rollout(name, cwd, text):
            lines = [{'timestamp': '2026-09-01T10:00:00Z', 'type': 'session_meta',
                      'payload': {'id': name, 'cwd': cwd}},
                     {'timestamp': '2026-09-01T10:01:00Z', 'type': 'response_item',
                      'payload': {'type': 'message', 'role': 'user',
                                  'content': [{'type': 'input_text', 'text': text}]}}]
            (codex / '2026' / f'rollout-{name}.jsonl').write_text(
                '\n'.join(json.dumps(line) for line in lines) + '\n')
        rollout('cx-in', root + '/sub', 'codex here')
        rollout('cx-out', root + '-other', 'codex elsewhere')
        folder = self.projects / agentsui.slug(root + '/sub')
        folder.mkdir(parents=True)
        (folder / 'cl-in.jsonl').write_text(json.dumps({
            'type': 'user', 'sessionId': 'cl-in', 'cwd': root + '/sub',
            'timestamp': '2026-09-02T10:00:00Z',
            'message': {'role': 'user', 'content': 'claude here'}}) + '\n')
        with patch.object(agentsui, 'CODEX_SESSIONS', codex):
            found = agentsui.project_sessions(root)
        self.assertEqual([(t.agent, t.session_id) for t in found],
                         [('claude', 'cl-in'), ('codex', 'cx-in')])


if __name__ == '__main__':
    unittest.main()
