import json, re, collections
rows = json.load(open('rows.json'))
hdr, data = rows[0], [r for r in rows[1:] if r]
NA = re.compile(r'^(n/?a|none|unknown|not unknow|-)$', re.I)
def v(r, c):
    s = (r.get(c) or '').strip()
    return None if not s or NA.match(s) else s
COORD = re.compile(r'([+-]?2[5-7]\.\d{3,})\s*,\s*([+-]?-?8[01]\.\d{3,})')
def iso(s):
    s = (s or '').strip()
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', s)
    if m: return m.group(0)
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})', s)
    return f'{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}' if m else None
STAGE = {'Section 1: Initial Inspection': 'INSPECTION',
         'Section 2: REPAIR / MAINTENANCE': 'REPAIR', 'Section 3: QC/QA': 'QC'}
def pics(s):
    m = re.match(r'(\d+)', s or ''); return int(m.group(1)) if m else 0

by = collections.OrderedDict()
for r in data:
    by.setdefault(v(r, 'A') or 'UNNUMBERED', []).append(r)

tasks = []
for key, rs in by.items():
    if key == 'UNNUMBERED': continue
    first = rs[0]
    coord = next((COORD.search(r.get('J') or '') for r in rs if COORD.search(r.get('J') or '')), None)
    stages = [{
        'stage': STAGE.get(v(r, 'AZ'), 'UNKNOWN'),
        'date': iso(v(r, 'L')) or iso(v(r, 'B')),
        'inspector': v(r, 'N') or v(r, 'S'),
        'preparedBy': v(r, 'AS'),
        'qcBy': v(r, 'AY'),
        'workDescription': v(r, 'AT'),
        'itemsRepaired': v(r, 'AV'),
        'repairBy': v(r, 'AU'),
        'thirdPartyName': v(r, 'AW'),
        'thirdPartyCostUSD': float(v(r, 'AX')) if v(r, 'AX') else None,
        'inspectionPhotos': pics(r.get('BE')),
        'repairPhotos': pics(r.get('BF')),
    } for r in rs]
    tasks.append({
        'taskNumber': key,
        'date': iso(v(first, 'L')) or iso(v(first, 'B')),
        'siteLocationText': v(first, 'J'),
        'longitude': float(coord.group(2)) if coord else None,
        'latitude': float(coord.group(1)) if coord else None,
        'laneDirection': v(first, 'P'),
        'stateRoad': v(first, 'R'),
        'respondedBy': [lbl for col, lbl in
                        [('T','TMC'),('U','Road Ranger'),('V','ACS Maintenance'),('Y','Police')]
                        if any(v(r, col) for r in rs)],
        'policeCaseNumber': next((v(r,'AK') for r in rs if v(r,'AK')), None),
        'hsmvNumber': next((v(r,'AL') for r in rs if v(r,'AL')), None),
        'eventNumber': next((v(r,'AM') for r in rs if v(r,'AM')), None),
        'officerName': next((v(r,'AN') for r in rs if v(r,'AN')), None),
        'licensePlate': next((v(r,'AP') for r in rs if v(r,'AP')), None),
        'vehicleModel': next((v(r,'AQ') for r in rs if v(r,'AQ')), None),
        'insuranceCarrier': next((v(r,'AR') for r in rs if v(r,'AR')), None),
        'assetTypeHint': next((v(r,'O') for r in rs if v(r,'O')), None),
        'stages': stages,
    })
out = {
  'source': 'ACS - General Accident and Repair Form (xlsx)',
  'rowsInFile': len(data), 'taskCount': len(tasks),
  'absentFromSource': ['labourHours', 'serviceVehicle', 'equipment', 'materials', 'totalCostUSD'],
  'note': ('Real ACS form submissions. Labour, equipment, MOT and material sub-tables were not '
           'flattened into the export and Total_Cost is empty on every row, so those are ABSENT, '
           'not zero. Photo counts are real; the image files were not supplied.'),
  'tasks': tasks,
}
json.dump(out, open('acsTasks.json', 'w'), indent=1)
print('tasks', len(tasks), '| coords', sum(1 for t in tasks if t['latitude']),
      '| cost', sum(1 for t in tasks if any(s['thirdPartyCostUSD'] for s in t['stages'])),
      '| photos', sum(1 for t in tasks if any(s['inspectionPhotos'] or s['repairPhotos'] for s in t['stages'])),
      '| event#', sum(1 for t in tasks if t['eventNumber']))
print(json.dumps(tasks[2], indent=1)[:700])
