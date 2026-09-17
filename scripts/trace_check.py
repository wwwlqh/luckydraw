"""Run: python scripts/trace_check.py

Fails when docs/ACCEPTANCE.md cites a requirement, property, section or ADR that
docs/SPEC.md does not define, or when any P/V/D requirement has no acceptance row.
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = (root / 'docs/SPEC.md').read_text(encoding='utf-8')
acc = (root / 'docs/ACCEPTANCE.md').read_text(encoding='utf-8')

sections = set(re.findall(r'^## (\d+)\. ', spec, re.M)) | set(re.findall(r'^### (\d+\.\d+) ', spec, re.M))
requirements = set(re.findall(r'^\| (P\d+) \|', spec, re.M))
properties = set(re.findall(r'\*\*([VD]\d+):\*\*', spec))
adrs = set(re.findall(r'^\| (\d{3}) \|', spec, re.M))
defined = requirements | properties

rows = [line for line in acc.splitlines() if re.match(r'^\| [AU]\d+ \|', line)]
errors, cited = [], set()
for line in rows:
    cells = [c.strip() for c in line.strip().strip('|').split('|')]
    row_id, cell = cells[0], cells[-1]
    ids = set(re.findall(r'\b([PVD]\d+)\b', cell))
    for kind, lo, hi in re.findall(r'\b([PVD])(\d+)[–-](?:[PVD])?(\d+)\b', cell):
        ids |= {f'{kind}{n}' for n in range(int(lo), int(hi) + 1)}
    for ref in ids:
        if ref not in defined:
            errors.append(f'{row_id}: {ref} is not defined in SPEC.md')
    cited |= ids
    secs = set(re.findall(r'§(\d+(?:\.\d+)?)', cell))
    for lo, hi in re.findall(r'§(\d+)[–-](\d+)\b', cell):
        secs |= {str(n) for n in range(int(lo), int(hi) + 1)}
    for sec in secs:
        if sec not in sections:
            errors.append(f'{row_id}: §{sec} does not exist')
    for adr in re.findall(r'ADR (\d{3})', cell):
        if adr not in adrs:
            errors.append(f'{row_id}: ADR {adr} does not exist')
    if not (ids or secs):
        errors.append(f'{row_id}: no spec citation')

for req in sorted(defined, key=lambda s: (s[0], int(s[1:]))):
    if req not in cited:
        errors.append(f'{req} has no acceptance row')

if errors:
    print('\n'.join(errors))
    sys.exit(1)
print(f'trace_check: {len(rows)} acceptance rows, {len(defined)} requirement IDs all covered, '
      f'{len(sections)} sections, {len(adrs)} ADRs; every citation resolves')
