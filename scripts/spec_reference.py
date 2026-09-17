"""Independent executable v8 math examples, NOT Solidity tests or a security audit.

Run: python scripts/spec_reference.py
No third-party packages, network or keys required. On success it refreshes the
reference fields of docs/SPEC_CHECKS.json.
"""
from datetime import datetime, timedelta, timezone
from fractions import Fraction
from itertools import product
from pathlib import Path
from random import Random
import hashlib
import json

MAX = 2**256 - 1
DAY = 86400
WEEK = 7 * DAY
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
checks = 0


def check(condition, label):
    global checks
    checks += 1
    if not condition:
        raise AssertionError(label)


def fee(gross):
    assert 0 <= gross <= MAX
    return gross * 300 // 10000


def fee_delta(before, amount):
    assert 0 < amount <= MAX - before
    return fee(before + amount) - fee(before)


def minimum(token_decimals, feed_decimals, price):
    assert 0 <= token_decimals <= 18 and 0 <= feed_decimals <= 18
    assert price > 0
    q, rem = divmod(10 ** (token_decimals + feed_decimals), price)
    return q + bool(rem)


def usd_value(gross, token_decimals, feed_decimals, price):
    return gross * price // 10 ** (token_decimals + feed_decimals)


def target_gross(token_decimals, feed_decimals, price, target_usd):
    q, rem = divmod(target_usd * 10 ** (token_decimals + feed_decimals), price)
    return q + bool(rem)


def valid_price(now, updated, age, answer, round_id=1, min_answer=0, max_answer=0):
    if min_answer and answer <= min_answer:
        return False
    if max_answer and answer >= max_answer:
        return False
    return round_id > 0 and answer > 0 and 0 < updated <= now and now - updated <= age


def max_price_age(heartbeat):
    age = max(2 * heartbeat, 3600)
    assert 60 <= age <= 172800
    return age


def civil_from_days(z):
    """Howard Hinnant's civil_from_days; z = days since 1970-01-01, z >= 0. All values nonnegative."""
    assert z >= 0
    z += 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    y = yoe + era * 400 + (1 if m <= 2 else 0)
    return y, m, d


def days_from_civil(y, m, d):
    """Howard Hinnant's days_from_civil for y >= 1970."""
    y -= 1 if m <= 2 else 0
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m - 3 if m > 2 else m + 9) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def cutoff(t, kind):
    if kind == 'Day':
        return (t // DAY + 1) * DAY
    if kind == 'Week':
        return ((t + 3 * DAY) // WEEK + 1) * WEEK - 3 * DAY
    if kind == 'Month':
        y, m, _ = civil_from_days(t // DAY)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        return days_from_civil(y, m, 1) * DAY
    raise ValueError(kind)


def calendar_reference(t, kind):
    instant = datetime.fromtimestamp(t, timezone.utc)
    day = instant.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    while True:
        if kind == 'Day' or (kind == 'Week' and day.weekday() == 0) or (kind == 'Month' and day.day == 1):
            return int(day.timestamp())
        day += timedelta(days=1)


def index_modular(w0, w1, weight):
    assert 0 <= w0 <= MAX and 0 <= w1 <= MAX and 0 < weight <= MAX
    b = (MAX % weight + 1) % weight
    return ((w0 * b) % weight + w1) % weight


def binary_winner(ranges, index):
    lo, hi = 0, len(ranges)
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if ranges[mid][1] <= index:
            lo = mid + 1
        else:
            hi = mid
    return ranges[lo][0]


def run():
    rng = Random(20260911)
    # Exact USD threshold, verified with rational values rather than rounded USD.
    for d, f in product(range(19), repeat=2):
        for price in [1, 3, 600 * 10**f, 987654321, 2**127-1]:
            m = minimum(d, f, price)
            value = lambda raw: Fraction(raw * price, 10**(d+f))
            check(value(m) >= 1, 'minimum reaches USD 1')
            check(value(m-1) < 1, 'one raw unit below minimum fails')
    check(minimum(18, 8, 600*10**8) == 1666666666666667, 'BNB USD threshold example')
    # Whole-USD target boundary: smallest pot that a fresh price values at or above the target.
    for d, f in product(range(0, 19, 3), repeat=2):
        for price in [1, 3, 600 * 10**f, 987654321]:
            for target in [10, 100, 1000, 10000, 100000]:
                g = target_gross(d, f, price, target)
                check(usd_value(g, d, f, price) >= target, 'target gross reaches target')
                check(usd_value(g - 1, d, f, price) < target, 'one raw unit below target fails')
                check(g >= minimum(d, f, price), 'target gross at least the USD 1 minimum')
    check(target_gross(18, 8, 600*10**8, 1000) == 1666666666666666667, 'BNB USD 1000 target example')
    check(usd_value(1666666666666666666, 18, 8, 600*10**8) == 999, 'one raw unit below the USD 1000 target values at USD 999')
    for now, updated, age, answer, round_id, expected in [
        (100, 100, 10, 1, 1, True), (100, 90, 10, 1, 1, True),
        (100, 89, 10, 1, 1, False), (100, 101, 10, 1, 1, False),
        (100, 0, 100, 1, 1, False), (100, 99, 10, 0, 1, False),
        (100, 99, 10, -1, 1, False), (100, 99, 10, 1, 0, False),
    ]:
        check(valid_price(now, updated, age, answer, round_id) == expected, 'freshness boundary')
    check(valid_price(100, 100, 10, 5, 1, 1, 10) and not valid_price(100, 100, 10, 1, 1, 1, 10) and not valid_price(100, 100, 10, 10, 1, 1, 10), 'aggregator bound clamp is invalid')
    check(max_price_age(27) == 3600 and max_price_age(1800) == 3600 and max_price_age(3600) == 7200, 'price age policy')
    check(max_price_age(86400) == 172800, 'price age upper bound')

    # Partition independence over full uint256 range, including near overflow.
    for total in [1, 33, 34, 99, 100, 1000, MAX, *[rng.randrange(1, MAX) for _ in range(1000)]]:
        cuts = sorted(set([0, total, *[rng.randrange(total+1) for _ in range(12)]]))
        pieces = [b-a for a,b in zip(cuts,cuts[1:])]
        before = fees = net = 0
        for g in pieces:
            f = fee_delta(before, g)
            check(f in (g*3//100, g*3//100+1), 'per-purchase rounding bounded')
            check(0 <= f <= g, 'fee never exceeds gross')
            fees += f
            net += g-f
            before += g
        check(fees == fee(total), 'split buys/wallets do not reduce total fee')
        check(fees+net == total, 'gross conservation')

    # Mathematically compare EVM modular expression with arbitrary-precision concat.
    for weight in [1, 2, 3, 20, 2**96, 2**255, MAX, *[rng.randrange(1, MAX) for _ in range(1000)]]:
        for a,b in [(0,0),(MAX,MAX),(rng.getrandbits(256),rng.getrandbits(256))]:
            got = index_modular(a,b,weight)
            check(got == ((a << 256) | b) % weight, '512-bit modulo equivalence')
            check(0 <= got < weight, 'index in range')

    # Exhaustive small repeat-buyer selection; linear owner list is the reference.
    for _ in range(1000):
        ranges, expanded, gross = [], [], 0
        for _ in range(rng.randint(1,20)):
            owner, g = rng.randrange(5), rng.randint(1,10)
            gross += g
            ranges.append((owner,gross))
            expanded.extend([owner]*g)
        for i, owner in enumerate(expanded):
            check(binary_winner(ranges,i) == owner, 'repeated buyer selection')
        check(ranges[-1][1] == gross == len(expanded), 'range conservation')
    # Synthetic large ledger verifies boundary lookup without a holder loop.
    large = [(i % 17, i+1) for i in range(100000)]
    for i in [0,1,49999,50000,99998,99999]:
        check(binary_winner(large,i) == i % 17, 'large ledger boundaries')

    # Civil-date algorithms match Python's calendar for every day 1970-2100 and round-trip.
    for z in range(0, days_from_civil(2101, 1, 1)):
        y, m, d = civil_from_days(z)
        date = (EPOCH + timedelta(days=z)).date()
        check((y, m, d) == (date.year, date.month, date.day), 'civil_from_days matches calendar')
        check(days_from_civil(y, m, d) == z, 'days_from_civil round trip')
    check(cutoff(int(datetime(2024,2,15,12,tzinfo=timezone.utc).timestamp()),'Month') == int(datetime(2024,3,1,tzinfo=timezone.utc).timestamp()), 'leap February month end')
    check(cutoff(int(datetime(2026,12,31,23,59,59,tzinfo=timezone.utc).timestamp()),'Month') == int(datetime(2027,1,1,tzinfo=timezone.utc).timestamp()), 'year end month cutoff')
    check(cutoff(int(datetime(2100,2,28,tzinfo=timezone.utc).timestamp()),'Month') == int(datetime(2100,3,1,tzinfo=timezone.utc).timestamp()), '2100 is not a leap year')
    check(cutoff(int(datetime(2026,9,11,tzinfo=timezone.utc).timestamp()),'Week') == int(datetime(2026,9,14,tzinfo=timezone.utc).timestamp()), 'next Monday example')

    # Independent calendar stepping includes epochs, leap days, month/year edges.
    instants = [0,1,DAY-1,DAY,3*DAY,4*DAY,7*DAY]
    for year in [1970,1999,2000,2024,2026,2028,2099,2100]:
        for month in range(1, 13):
            ts = int(datetime(year,month,1,tzinfo=timezone.utc).timestamp())
            instants += [max(0,ts-1),ts,ts+1,ts+86399]
        for month, day in [(2,28),(2,29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28),(9,11),(12,31)]:
            ts = int(datetime(year,month,day,tzinfo=timezone.utc).timestamp())
            instants += [max(0,ts-1),ts,ts+1,ts+86399]
    instants += [rng.randrange(0,4102444800) for _ in range(1000)]
    for t,kind in product(instants,['Day','Week','Month']):
        end=cutoff(t,kind)
        check(end == calendar_reference(t,kind), 'UTC independent calendar reference')
        check(end > t, 'strictly future cutoff')
        check(cutoff(end-1,kind) == end, 'buy last-second interval')
        check(cutoff(end,kind) > end, 'new round at exact cutoff')
        check(end % DAY == 0, 'cutoff at UTC midnight')

    # Worked ledger: gross stays in escrow; either settlement or full cancellation.
    gross = [100,200,700]
    total = sum(gross)
    available_before = [1000,1000,1000]
    after_buy = [a-g for a,g in zip(available_before,gross)]
    pot, reserved = total-fee(total), fee(total)
    check((pot,reserved) == (970,30), 'worked distribution amounts')
    check(sum(after_buy)+total == sum(available_before), 'buy escrow conservation')
    after_settle=after_buy.copy(); after_settle[0]+=pot
    check(sum(after_settle)+reserved == sum(available_before), 'winner/fee credit conservation')
    after_refund=[a+g for a,g in zip(after_buy,gross)]
    check(after_refund==available_before, 'cancellation returns full gross')

    # Deterministic differential vectors for Solidity and client math (F1).
    here = Path(__file__).resolve()
    vec = Random(20260911)
    vectors = {'minimum': [], 'targetGross': [], 'feeSequences': [], 'indexModular': [], 'cutoffs': [], 'binarySearch': []}
    for d, f in product([0, 8, 18], repeat=2):
        for p in [1, 600 * 10**f, 987654321]:
            for target in [100, 1000, 10000, 100000]:
                vectors['targetGross'].append({'tokenDecimals': d, 'feedDecimals': f, 'price': str(p), 'targetUsd': target, 'minGrossToReach': str(target_gross(d, f, p, target))})
    for d, f in product([0, 6, 8, 9, 18], repeat=2):
        for p in [1, 3, 600 * 10**f, 987654321, 2**127 - 1]:
            vectors['minimum'].append({'tokenDecimals': d, 'feedDecimals': f, 'price': str(p), 'minGrossRaw': str(minimum(d, f, p))})
    for total in [1, 33, 34, 99, 100, 1000, MAX, *[vec.randrange(1, MAX) for _ in range(20)]]:
        cuts = sorted(set([0, total, *[vec.randrange(total + 1) for _ in range(6)]]))
        seq, before = [], 0
        for g in [b - a for a, b in zip(cuts, cuts[1:])]:
            fd = fee_delta(before, g); before += g
            seq.append({'gross': str(g), 'feeDelta': str(fd), 'grossTotal': str(before), 'feeReserved': str(fee(before))})
        vectors['feeSequences'].append(seq)
    for weight in [1, 2, 3, 20, 2**96, 2**255, MAX, *[vec.randrange(1, MAX) for _ in range(30)]]:
        for a, b in [(0, 0), (MAX, MAX), (vec.getrandbits(256), vec.getrandbits(256))]:
            vectors['indexModular'].append({'word0': str(a), 'word1': str(b), 'weight': str(weight), 'index': str(index_modular(a, b, weight))})
    month_edges = [int(datetime(y, m, 1, tzinfo=timezone.utc).timestamp()) - 1 for y in [2024, 2026, 2100] for m in range(1, 13)]
    for t in [0, 1, DAY - 1, DAY, 345599, 345600, *month_edges, *[vec.randrange(0, 4102444800) for _ in range(100)]]:
        vectors['cutoffs'].append({'t': t, **{k: cutoff(t, k) for k in ['Day', 'Week', 'Month']}})
    for _ in range(20):
        ranges, gross = [], 0
        for _ in range(vec.randint(1, 12)):
            owner, g = vec.randrange(5), vec.randint(1, 10); gross += g; ranges.append((owner, gross))
        idx = [0, gross - 1, *[vec.randrange(gross) for _ in range(5)]]
        vectors['binarySearch'].append({'ranges': [{'buyer': o, 'cumulativeGross': c} for o, c in ranges],
                                        'cases': [{'index': i, 'buyer': binary_winner(ranges, i)} for i in idx]})
    vectors_path = here.parents[1] / 'contracts/test/vectors/spec_vectors.json'
    vectors_path.parent.mkdir(parents=True, exist_ok=True)
    vectors_path.write_text(json.dumps({'spec': 'v8', 'seed': 20260911, **vectors}, indent=1) + '\n', encoding='utf-8', newline='\n')

    coverage = ['USD threshold/freshness','whole-USD target boundaries','fee partition and conservation',
                '512-bit modulo','repeat-buyer range selection',
                'UTC daily/weekly/monthly boundaries and civil-date algorithms',
                'settlement/refund ledger example']
    print(json.dumps({
        'spec':'v8', 'result':'PASS', 'assertions':checks, 'seed':20260911, 'coverage':coverage,
        'limitation':'Independent math reference only; not contract, UI, VRF integration or security tests.'
    },indent=2))
    here = Path(__file__).resolve()
    checks_path = here.parents[1] / 'docs/SPEC_CHECKS.json'
    record = json.loads(checks_path.read_text(encoding='utf-8')) if checks_path.exists() else {}
    record.update({'spec':'v8', 'checkedAtUtc':datetime.now(timezone.utc).isoformat(), 'referenceResult':'PASS',
                   'referenceAssertions':checks, 'referenceSeed':20260911, 'referenceCoverage':coverage,
                   'referenceSha256':hashlib.sha256(here.read_bytes()).hexdigest()})
    checks_path.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8', newline='\n')


if __name__=='__main__':
    run()
