"""Reproduce the immutable daily reference corpus using only Python's standard library."""
import csv
import hashlib
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

REVISION = 'f1a36afb962731c387bb03982758ab0103063da5'
ROOT = Path(__file__).resolve().parents[1] / 'benchmarks/price-quality/v1'
rows, provenance = [], []
for asset in ('BTC', 'ETH'):
    url = f'https://raw.githubusercontent.com/coinmetrics/data/{REVISION}/csv/{asset.lower()}.csv'
    with urlopen(url, timeout=60) as response:
        raw = response.read()
    provenance.append({'url': url, 'sha256': hashlib.sha256(raw).hexdigest()})
    for row in csv.DictReader(io.StringIO(raw.decode())):
        if '2024-01-01' <= row['time'] < '2026-01-01':
            price = row['PriceUSD']
            if not price:
                raise ValueError(f'Missing reference: {asset} {row["time"]}')
            rows.append({'asset': asset, 'timestamp': int(datetime.fromisoformat(row['time']).replace(tzinfo=timezone.utc).timestamp()) + 86400,
                         'price': price, 'reference': 'coinmetrics-price-usd'})
rows.sort(key=lambda row: (row['timestamp'], row['asset']))
raw = ''.join(json.dumps(row, separators=(',', ':')) + '\n' for row in rows)
ROOT.mkdir(parents=True, exist_ok=True)
(ROOT / 'references.jsonl').write_text(raw)
manifest = {'version': '1', 'owner': 'Price quality and explainability maintainers',
            'sha256': hashlib.sha256(raw.encode()).hexdigest(), 'start': 1704153600, 'end': 1767312000,
            'intervalSeconds': 86400, 'assets': ['BTC', 'ETH'], 'provenance': provenance,
            'selection': 'BTC and ETH selected by liquidity and availability before examining aggregator errors; all daily UTC PriceUSD rows (day labels shifted +86400 seconds to the actual UTC close) in calendar 2024 and 2025. Independent of the four configured oracle adapters, not independent venues within Coin Metrics.',
            'coverageNotes': 'Daily USD reference grid only; no intraday, XLM, stablecoins, illiquid assets or venue independence claim. Exact UTC closing timestamps only (+86400 seconds from source day label). Coin Metrics methodology governs reference timestamps; no interpolation or forward fill.',
            'license': 'Coin Metrics data: CC BY-NC 4.0; attribution Coin Metrics, Inc. Noncommercial benchmark use only; not a production price feed. See LICENSE.reference.txt.'}
(ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
