"""Regression tests for the generated-artifact CI gate. Run with unittest discovery."""
import json
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest

from check_generated import INPUTS, OUTPUTS, check


class GeneratedCheckTest(unittest.TestCase):
    def setUp(self):
        self.scratch = TemporaryDirectory(prefix='luckydraw-check-test-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        source = Path(__file__).resolve().parents[1]
        for relative in set(INPUTS + OUTPUTS):
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, destination)

    def update_record(self, **fields):
        path = self.root / 'docs/SPEC_CHECKS.json'
        record = json.loads(path.read_text(encoding='utf-8'))
        record.update(fields)
        path.write_text(json.dumps(record), encoding='utf-8')

    def test_timestamp_difference_is_ignored_without_rewriting_input(self):
        self.update_record(checkedAtUtc='2000-01-01T00:00:00+00:00')
        path = self.root / 'docs/SPEC_CHECKS.json'
        before = path.read_bytes()
        self.assertEqual(check(self.root), [])
        self.assertEqual(path.read_bytes(), before)

    def test_stale_reference_and_source_fields_fail(self):
        self.update_record(sourceSha256='wrong', referenceSha256='wrong', referenceAssertions=0)
        self.assertIn('docs/SPEC_CHECKS.json', check(self.root))

    def test_changed_html_and_vectors_fail(self):
        for relative in ('docs/SPEC.html', 'contracts/test/vectors/spec_vectors.json'):
            with (self.root / relative).open('ab') as target:
                target.write(b'changed')
        self.assertCountEqual(check(self.root), ['docs/SPEC.html', 'contracts/test/vectors/spec_vectors.json'])

    def test_markdown_change_requires_new_artifacts(self):
        with (self.root / 'docs/SPEC.md').open('a', encoding='utf-8') as target:
            target.write('\nNew specification text.\n')
        self.assertCountEqual(check(self.root), ['docs/SPEC_CHECKS.json', 'docs/SPEC.html'])


if __name__ == '__main__':
    unittest.main()
