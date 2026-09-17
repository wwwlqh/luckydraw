"""Run: python scripts/render_spec.py (requires Python Markdown).

Renders docs/SPEC.html and refreshes the document fields of docs/SPEC_CHECKS.json.
"""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import re
import markdown
from html.parser import HTMLParser

root = Path(__file__).resolve().parents[1]
source = (root / 'docs/SPEC.md').read_text(encoding='utf-8')
assert re.findall(r'^## (\d+)\. ', source, re.M) == [str(n) for n in range(1, 18)]
assert source.count('```') % 2 == 0
title = re.search(r'^# (.+)$', source, re.M).group(1)
version = re.search(r'\bv\d+\b', title).group(0)
for name in [*['V' + str(n) for n in range(1, 6)], *['D' + str(n) for n in range(1, 11)]]:
    assert len(re.findall(r'\*\*' + name + r':\*\*', source)) == 1, name
assert all(1 <= int(n) <= 17 for n in re.findall(r'§(\d+)', source))
md = markdown.Markdown(extensions=['tables', 'fenced_code', 'toc'])
body = md.convert(source)
digest = hashlib.sha256(source.encode()).hexdigest()
page = '''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__SPEC_TITLE__</title><style>
:root{color-scheme:light dark;--bg:#f6f5f1;--fg:#20242b;--line:#d7d5cc;--panel:#fff;--accent:#795400}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,sans-serif}
.layout{max-width:1420px;margin:auto;display:grid;grid-template-columns:265px minmax(0,1fr);gap:44px;padding:36px}
nav{position:sticky;top:24px;align-self:start;max-height:92vh;overflow:auto;font-size:13px}nav ul{padding-left:18px}nav li{margin:7px 0}nav>p{font-weight:700}main{min-width:0;max-width:1000px}
h1{font-size:2.5rem;line-height:1.15;letter-spacing:-.04em}h2{margin-top:52px;padding-top:18px;border-top:2px solid var(--line);scroll-margin-top:20px}h3{margin-top:30px}
p,li{max-width:88ch}a{color:var(--accent)}code{font:0.86em/1.6 ui-monospace,monospace}pre{overflow:auto;background:var(--panel);padding:20px;border:1px solid var(--line);border-radius:8px}
table{display:block;overflow-x:auto;border-collapse:collapse;font-size:14px;margin:20px 0;width:100%}th,td{border-bottom:1px solid var(--line);text-align:left;vertical-align:top;padding:11px 13px;min-width:125px}th{background:var(--panel)}
@media(prefers-color-scheme:dark){:root{--bg:#17191e;--fg:#e8e8e3;--line:#3b3d42;--panel:#20232a;--accent:#ebc46d}}
@media(max-width:900px){.layout{display:block;padding:20px}nav{position:static;max-height:none}nav .toc>ul>li>ul{display:none}h1{font-size:2rem}}
@media print{nav{display:none}.layout{display:block;padding:0}body{font-size:11px;background:white;color:black}table{display:table;font-size:10px}pre{white-space:pre-wrap}h2,h3{break-after:avoid}tr{break-inside:avoid}}
</style></head><body><div class="layout"><nav aria-label="Contents"><p>LuckyDraw / Spec __SPEC_VERSION__</p>'''
from html import escape
page = page.replace('__SPEC_TITLE__', escape(title)).replace('__SPEC_VERSION__', version)
page += md.toc + '</nav><main>' + body + '</main></div>'
page += '\n<!-- Source SHA256: ' + digest + ' -->\n</body></html>\n'
class LinkCheck(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.anchors = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if 'id' in a:
            self.ids.append(a['id'])
        if tag == 'a' and a.get('href', '').startswith('#'):
            self.anchors.append(a['href'][1:])
check = LinkCheck()
check.feed(page)
assert len(check.ids) == len(set(check.ids)), 'Duplicate HTML anchors'
assert not set(check.anchors) - set(check.ids), 'Missing table-of-contents targets'
(root / 'docs/SPEC.html').write_text(page, encoding='utf-8', newline='\n')
checks_path = root / 'docs/SPEC_CHECKS.json'
record = json.loads(checks_path.read_text(encoding='utf-8')) if checks_path.exists() else {}
record.update({'spec': version, 'checkedAtUtc': datetime.now(timezone.utc).isoformat(), 'documentResult': 'PASS',
               'sections': 17, 'propertyIds': 15, 'sourceSha256': digest})
checks_path.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8', newline='\n')
print(f'Rendered {version}: 17 sections, 15 property IDs, {len(check.anchors)} valid contents links; source SHA256 {digest}')
