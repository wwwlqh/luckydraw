"""Regenerate spec artifacts in a temporary copy and check deterministic content.

Run: python scripts/check_generated.py (requires Python Markdown).
The working tree is never rewritten. Only SPEC_CHECKS.checkedAtUtc is excluded
from comparison; hashes, assertion counts, HTML and vectors must still match.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory


INPUTS = (
    'docs/SPEC.md',
    'docs/SPEC_CHECKS.json',
    'scripts/spec_reference.py',
    'scripts/render_spec.py',
)
OUTPUTS = (
    'docs/SPEC_CHECKS.json',
    'docs/SPEC.html',
    'contracts/test/vectors/spec_vectors.json',
)


def comparable(path):
    if path.name == 'SPEC_CHECKS.json':
        record = json.loads(path.read_text(encoding='utf-8'))
        record.pop('checkedAtUtc', None)
        return record
    return path.read_bytes()


def check(root):
    with TemporaryDirectory(prefix='luckydraw-generated-') as scratch:
        generated = Path(scratch)
        for relative in INPUTS:
            destination = generated / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / relative, destination)
        for script in ('spec_reference.py', 'render_spec.py'):
            result = subprocess.run(
                [sys.executable, str(generated / 'scripts' / script)],
                cwd=generated, capture_output=True, text=True, encoding='utf-8',
            )
            if result.returncode:
                raise RuntimeError(f'{script} failed:\n{result.stdout}{result.stderr}')
        return [
            relative for relative in OUTPUTS
            if not (root / relative).is_file()
            or comparable(root / relative) != comparable(generated / relative)
        ]


if __name__ == '__main__':
    mismatches = check(Path(__file__).resolve().parents[1])
    if mismatches:
        print('Stale generated artifacts:\n' + '\n'.join(mismatches))
        print('Run python scripts/spec_reference.py and python scripts/render_spec.py, then review the changes.')
        sys.exit(1)
    print('generated_check: PASS (hashes, reference results, HTML and vectors; checkedAtUtc excluded)')
