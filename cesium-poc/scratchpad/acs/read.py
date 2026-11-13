import zipfile, re, json, datetime
from xml.etree import ElementTree as ET
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
z = zipfile.ZipFile('book.xlsx')
shared = []
if 'xl/sharedStrings.xml' in z.namelist():
    for si in ET.fromstring(z.read('xl/sharedStrings.xml')):
        shared.append(''.join(t.text or '' for t in si.iter(NS + 't')))
styles = ET.fromstring(z.read('xl/styles.xml'))
custom = {int(n.get('numFmtId')): n.get('formatCode') for n in styles.iter(NS + 'numFmt')}
xf = styles.find(NS + 'cellXfs')
fmt_of_style = [int(x.get('numFmtId', 0)) for x in xf] if xf is not None else []
DATE_BUILTIN = set(range(14, 23)) | set(range(45, 48)) | {27, 30, 36, 50, 57}
def is_date(style):
    if style is None: return False
    try: fid = fmt_of_style[int(style)]
    except (IndexError, ValueError): return False
    if fid in DATE_BUILTIN: return True
    code = custom.get(fid, '')
    return bool(re.search(r'[dmyh]', code)) and 'General' not in code
def serial_to_iso(v):
    try: n = float(v)
    except (TypeError, ValueError): return v
    d = datetime.datetime(1899, 12, 30) + datetime.timedelta(days=n)
    return d.strftime('%Y-%m-%d %H:%M:%S' if n % 1 else '%Y-%m-%d')
rows = []
for row in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).iter(NS + 'row'):
    cells = {}
    for c in row.iter(NS + 'c'):
        col = re.match(r'[A-Z]+', c.get('r')).group()
        t = c.get('t'); vv = c.find(NS + 'v'); isel = c.find(NS + 'is')
        if t == 's' and vv is not None: val = shared[int(vv.text)]
        elif t == 'inlineStr' and isel is not None:
            val = ''.join(x.text or '' for x in isel.iter(NS + 't'))
        elif vv is not None:
            val = serial_to_iso(vv.text) if is_date(c.get('s')) else vv.text
        else: val = None
        if val is not None and str(val).strip() != '': cells[col] = str(val).strip()
    rows.append(cells)
json.dump(rows, open('rows.json', 'w'), indent=0)
print('sheet rows:', len(rows), ' non-empty:', sum(1 for r in rows if r))
