"""Read-only statement analysis. Set BOT_STATEMENT_DIR to the five original CSVs.

Closing deals are authoritative for realised statement money. Entry cohorts are
a separately labelled proxy, never certified broker position lifecycles.
"""
import csv
import hashlib
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

SGT = timezone(timedelta(hours=8))
AS_OF = datetime(2026, 10, 1, 6, 22, tzinfo=SGT)
INPUT_DIR = Path(os.environ.get('BOT_STATEMENT_DIR', 'statements'))
MANIFEST = {
    '42993489': '984b5c82caab43b8aa26779e5db0fb33f4f7143cd76afb283f8bc52967e2faf6',
    '46979908': '21d8c99f3cbf45e9b4847268979c331d14b173dc8954af88df0c06b015ea738e',
    '43097342': '79006ea2c3e5da9124ff277626b5c8c9b2acf6182cd40ca934581b2f9d4a3af1',
    '46130058': '5339f3f47169c5e8fc70c8a9639a492f7e0f9ceb137686dc8d9d43f9bf5e2960',
    '47790949': '6699c86c76637763871e56e3facf93f162ed27993fd98aafa0ba83487cf5c472',
}


def number(value):
    return Decimal(value.replace('\u00a0', '').replace(' ', '').replace(',', ''))


def stamp(value):
    fmt = '%d %b %Y %H:%M:%S.%f' if '.' in value else '%d %b %Y %H:%M:%S'
    return datetime.strptime(value, fmt).replace(tzinfo=SGT)


def parse(path):
    sections, section, header = {}, None, None
    with path.open(encoding='utf-8-sig', newline='') as file:
        reader = csv.reader(file)
        for row in reader:
            if not row or not any(row):
                continue
            if len(row) == 1 and row[0] in {'Deals', 'Positions', 'Orders', 'Transactions', 'Summary', 'Balance'}:
                section, header = row[0], None
                sections[section] = []
                continue
            if section == 'Balance':
                continue
            if header is None:
                header = row
                continue
            assert len(row) == len(header), (path.name, reader.line_num, 'row shape')
            sections[section].append(dict(zip(header, row), line=reader.line_num))
    return sections


def metrics(rows):
    values = [r['net'] for r in rows]
    wins = [v for v in values if v > 0]
    losses = [v for v in values if v < 0]
    gain, loss = sum(wins, Decimal(0)), -sum(losses, Decimal(0))
    # Closed-realised P&L drawdown; no floating P&L, cashflows or account equity.
    running = peak = drawdown = Decimal(0)
    for row in sorted(rows, key=lambda r: (r['closed'], r['tie'])):
        running += row['net']
        peak = max(peak, running)
        drawdown = max(drawdown, peak - running)
    return {
        'n': len(rows), 'wins': len(wins), 'losses': len(losses), 'scratches': values.count(Decimal(0)),
        'wr_pct': 100 * len(wins) / len(rows) if rows else None,
        'pf': float(gain / loss) if loss else None,
        'net': str(gain - loss), 'winning_net': str(gain), 'losing_net_abs': str(loss),
        'avg_win': str(gain / len(wins)) if wins else None,
        'avg_loss_abs': str(loss / len(losses)) if losses else None,
        'closed_realised_drawdown': str(drawdown),
    }


RESULT = {'as_of_sgt': AS_OF.isoformat(), 'accounts': {}}
for account, expected_hash in MANIFEST.items():
    matches = [p for p in INPUT_DIR.glob('*.csv') if f'({account})' in p.name]
    assert len(matches) == 1, (account, 'exactly one original statement required')
    path = matches[0]
    actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    assert actual_hash == expected_hash, (account, 'input changed')
    sections = parse(path)
    deals = [r for r in sections['Deals'] if r['Deal ID']]
    footers = [r for r in sections['Deals'] if not r['Deal ID']]
    assert len(footers) == 1
    assert len({r['Deal ID'] for r in deals}) == len(deals), (account, 'duplicate deal IDs')
    net_columns = {k for r in deals for k in r if k.startswith('Net ')}
    assert len(net_columns) == 1
    net_column = next(iter(net_columns))
    currency = net_column[4:]
    assert currency in {'SGD', 'USD'}
    cohorts, deal_rows = {}, []
    for r in deals:
        opened, closed = stamp(r['Opening time (UTC+8)']), stamp(r['Closing Time (UTC+8)'])
        assert opened <= closed <= AS_OF, (account, r['line'], 'invalid date')
        assert r['Opening Direction'] in {'Buy', 'Sell'}
        key = (r['Symbol'], r['Opening Direction'], opened, number(r['Entry price']))
        cohort = cohorts.setdefault(key, {'rows': [], 'open_lines': []})
        row = {'net': number(r[net_column]), 'closed': closed, 'tie': r['Deal ID'],
               'side': r['Opening Direction'], 'channel': r['Channel'], 'symbol': r['Symbol'],
               'line': r['line'], 'commission': number(r['Commissions'])}
        cohort['rows'].append(row)
        deal_rows.append(row)
    unmatched_open = []
    for position in sections.get('Positions', []):
        opened = stamp(position['Created (UTC+8)'])
        matches = [k for k in cohorts if k[0] == position['Symbol'] and k[1] == position['Direction']
                   and k[2].replace(microsecond=0) == opened.replace(microsecond=0)
                   and k[3] == number(position['Entry'])]
        assert len(matches) <= 1, (account, position['line'], 'ambiguous open match')
        if matches:
            cohorts[matches[0]]['open_lines'].append(position['line'])
        else:
            unmatched_open.append(position['line'])
    assert sum((r['net'] for r in deal_rows), Decimal(0)) == number(footers[0][net_column]), (account, 'net footer')
    assert sum((r['commission'] for r in deal_rows), Decimal(0)) == number(footers[0]['Commissions']), (account, 'commission footer')
    closed_cohorts, exclusions = [], []
    for key, cohort in cohorts.items():
        rows = cohort['rows']
        if cohort['open_lines']:
            exclusions.append({'symbol': key[0], 'side': key[1], 'opened_sgt': key[2].isoformat(),
                'deal_lines': [r['line'] for r in rows], 'open_lines': cohort['open_lines'],
                'partial_realised_net': str(sum((r['net'] for r in rows), Decimal(0)))})
            continue
        closed_cohorts.append({'net': sum((r['net'] for r in rows), Decimal(0)),
            'closed': max(r['closed'] for r in rows), 'tie': min(r['tie'] for r in rows),
            'side': key[1], 'symbol': key[0], 'opened': key[2],
            'closing_channels': sorted({r['channel'] for r in rows}),
            'deal_lines': [r['line'] for r in rows]})
    assert sum(len(c['deal_lines']) for c in closed_cohorts) + sum(len(e['deal_lines']) for e in exclusions) == len(deals)
    closing_channels = defaultdict(list)
    for r in deal_rows:
        closing_channels[r['channel']].append(r)
    windows = {'statement': closed_cohorts,
        'last_30d': [r for r in closed_cohorts if AS_OF - timedelta(days=30) <= r['closed'] <= AS_OF],
        'latest_20': sorted(closed_cohorts, key=lambda r: (r['closed'], r['tie']))[-20:]}
    RESULT['accounts'][account] = {
        'filename': path.name, 'sha256': actual_hash, 'currency': currency,
        'first_close_sgt': min(r['closed'] for r in deal_rows).isoformat(),
        'last_close_sgt': max(r['closed'] for r in deal_rows).isoformat(),
        'deal_metrics': metrics(deal_rows),
        'cohort_metrics': {name: metrics(rows) for name, rows in windows.items()},
        'direction_metrics': {name: {side: metrics([r for r in rows if r['side'] == side])
                            for side in ['Buy', 'Sell']} for name, rows in windows.items()},
        'closing_channel_deal_metrics': {channel: metrics(rows) for channel, rows in sorted(closing_channels.items())},
        'open_position_rows': len(sections.get('Positions', [])),
        'unmatched_open_position_lines': unmatched_open,
        'excluded_open_cohorts': exclusions,
        'multi_deal_closed_cohorts': sum(len(r['deal_lines']) > 1 for r in closed_cohorts),
        'cohort_audit': [dict(r, net=str(r['net']), closed=r['closed'].isoformat(), opened=r['opened'].isoformat())
                         for r in sorted(closed_cohorts, key=lambda r: (r['closed'], r['tie']))],
        'worst_10_cohorts': [dict(r, net=str(r['net']), closed=r['closed'].isoformat(), opened=r['opened'].isoformat())
                            for r in sorted(closed_cohorts, key=lambda r: r['net'])[:10]],
        'quality': {'input_hash': 'PASS', 'shape': 'PASS', 'unique_deal_ids': 'PASS',
            'dates': 'PASS', 'net_footer': 'PASS', 'commission_footer': 'PASS',
            'unambiguous_open_matches': 'PASS', 'full_deal_partition': 'PASS',
            'position_id': 'ABSENT', 'strategy': 'ABSENT', 'mae_mfe': 'ABSENT',
            'closed_exit_reason': 'ABSENT', 'full_lifecycle_volume_balance': 'NOT_VERIFIABLE'},
    }

print(json.dumps({a: {k: v[k] for k in ['currency', 'deal_metrics', 'cohort_metrics',
    'direction_metrics', 'closing_channel_deal_metrics', 'open_position_rows', 'excluded_open_cohorts']}
    for a, v in RESULT['accounts'].items()}, indent=2))
