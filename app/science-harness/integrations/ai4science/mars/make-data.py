"""Generate the simulated historical archive (spec v0.2 section 4) and its evaluator answers (task R7)."""
import argparse
import hashlib
import json
import math
import pathlib
import random
import sqlite3
import statistics

SOL_SECONDS = 88775
TICK_SECONDS = SOL_SECONDS / 96
MIGRATION_TICK = -20000
MIGRATION_EARTH = 1_700_000_000  # Earth epoch seconds at the clock migration
EARLIEST_TICK = -60000


def earth_time(tick: int) -> str:
    seconds = MIGRATION_EARTH + (tick - MIGRATION_TICK) * TICK_SECONDS
    import datetime
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class Sensors:
    """Accumulates sensor rows; pre-migration rows carry only an Earth timestamp."""

    def __init__(self):
        self.rows = []

    def add(self, tick, entity, metric, value, unit, quality='observed'):
        legacy = tick < MIGRATION_TICK
        self.rows.append([None, None if legacy else tick, earth_time(tick) if legacy else None, entity, metric,
                          None if quality == 'missing' else value, unit, quality])


def build(truth: dict, rng: random.Random, scale: float):
    sensors = Sensors()
    answers = {}
    corrections = {}  # row index -> (value, reason)

    # Q1 filter removal rate (one reading per sol after migration, plus legacy readings)
    historical_removal = truth['water']['removal'] + rng.uniform(-0.05, 0.05)
    q1_rows = []
    for tick in range(EARLIEST_TICK, 0, max(24, int(96 / scale))):
        quality = 'missing' if rng.random() < 0.01 else 'observed'
        value = round(min(0.98, max(0.3, rng.gauss(historical_removal, 0.03))), 4)
        q1_rows.append(len(sensors.rows))
        sensors.add(tick, 'filter', 'removal_rate', value, 'fraction', quality)
    for row in rng.sample(q1_rows, max(3, len(q1_rows) // 30)):
        if sensors.rows[row][5] is not None:
            corrections[row] = (round(sensors.rows[row][5] - rng.choice([-1, 1]) * rng.uniform(0.08, 0.15), 4), '传感器量程错误，按复核值更正')

    # Q2 cold-1 over-temperature episodes; legacy section in Fahrenheit
    q2_rows = []
    step = max(4, int(16 / scale))
    episode_starts = sorted(rng.sample(range(EARLIEST_TICK + step * 40, -400, step * 25), 9))
    episodes = {start: rng.randint(3, 8) for start in episode_starts[:7]}
    spikes = {start: 2 for start in episode_starts[7:]}
    hot = {}
    for start, length in {**episodes, **spikes}.items():
        for index in range(length):
            hot[start + index * step] = round(rng.uniform(8.6, 12.0), 2)
    for tick in range(EARLIEST_TICK, 0, step):
        celsius = hot.get(tick, round(rng.gauss(4.0, 0.5), 2))
        legacy = tick < MIGRATION_TICK
        value, unit = (round(celsius * 9 / 5 + 32, 2), 'F') if legacy else (celsius, 'C')
        q2_rows.append(len(sensors.rows))
        sensors.add(tick, 'cold-1', 'temperature', value, unit)
    # One reported episode is a sensor artefact later corrected to normal readings
    artefact = rng.choice(list(episodes))
    for index in range(episodes[artefact]):
        tick = artefact + index * step
        row = next(r for r in q2_rows if (sensors.rows[r][1] == tick) or (sensors.rows[r][1] is None and sensors.rows[r][2] == earth_time(tick)))
        normal = round(rng.gauss(4.0, 0.3), 2)
        corrections[row] = (round(normal * 9 / 5 + 32, 2) if tick < MIGRATION_TICK else normal, '冷机探头接触不良，读数作废并以复核值替代')
    answers['Q2'] = len(episodes) - 1

    # Q6 legacy life-support CO2 flow in mL/min (before migration only)
    mean_flow = rng.uniform(40, 60)
    q6_values = []
    for tick in range(EARLIEST_TICK, MIGRATION_TICK, max(2, int(8 / scale))):
        quality = 'missing' if rng.random() < 0.01 else 'observed'
        value = round(rng.gauss(mean_flow, 4), 3)
        row = len(sensors.rows)
        sensors.add(tick, 'lifesupport', 'co2_flow', value, 'mL/min', quality)
        if quality == 'observed':
            if rng.random() < 0.02:
                corrected = round(value * rng.uniform(0.8, 0.95), 3)
                corrections[row] = (corrected, '流量计零点漂移更正')
                q6_values.append(corrected)
            else:
                q6_values.append(value)
    answers['Q6'] = round(statistics.fmean(q6_values) * SOL_SECONDS / 60 / 1000, 4)

    # Q7 centrifuge vibration RMS episodes ending in failure
    maintenance_extra = []
    intervals = []
    for episode in range(max(4, int(8 * min(scale, 2)))):
        device = f'centrifuge-{episode % 2 + 1}'
        failure = rng.randint(EARLIEST_TICK + 3000, -500)
        rise = rng.randint(250, 700)
        crossing = None
        for tick in range(failure - rise - 400, failure + 1, 4):
            progress = max(0.0, (tick - (failure - rise - 200)) / (rise + 200))
            value = round(1.0 + 1.6 * progress ** 1.5 + rng.gauss(0, 0.05), 3)
            if crossing is None and value > 2.0:
                crossing = tick
            sensors.add(tick, device, 'vibration_rms', value, 'mm/s')
        intervals.append(failure - crossing)
        maintenance_extra.append((failure, device, 'failure', json.dumps({'detail': '轴承失效停机', 'episode': episode + 1}, ensure_ascii=False)))
    answers['Q7'] = round(statistics.fmean(intervals), 2)

    # Filler sensor series up to the requested scale
    target = int(2_000_000 * scale)
    filler = [('incubator-1', 'temperature', 22, 'C'), ('incubator-2', 'temperature', 22, 'C'), ('incubator-3', 'temperature', 22, 'C'),
              ('incubator-4', 'temperature', 22, 'C'), ('incubator-1', 'light', 70, '%'), ('incubator-2', 'co2', 800, 'ppm'),
              ('reservoir', 'level', 4000, 'uL'), ('filter', 'pressure_diff', 12, 'kPa'), ('pump', 'flow', 50, 'uL/tick'),
              ('energy', 'solar', 14, 'kW'), ('energy', 'soc', 0.7, 'fraction'), ('cold-2', 'temperature', 4, 'C'),
              ('freezer', 'temperature', -10, 'C'), ('confirm', 'lamp_intensity', 1.0, 'relative'), ('imager', 'lamp_intensity', 1.0, 'relative'),
              ('robot-1', 'motor_current', 2.0, 'A'), ('lifesupport', 'cabin_temp', 71.6, 'F')]
    remaining = max(0, target - len(sensors.rows))
    per_series = max(1, remaining // len(filler))
    for index, (entity, metric, base, unit) in enumerate(filler):
        for n in range(per_series):
            tick = EARLIEST_TICK + int(n * (-EARLIEST_TICK) / per_series)
            quality = 'missing' if rng.random() < 0.01 else 'reviewed' if rng.random() < 0.005 else 'observed'
            value = round(base + math.sin(tick / 113 + index) * base * 0.03 + rng.gauss(0, abs(base) * 0.01 + 0.01), 4)
            sensors.add(tick, entity, metric, value, unit, quality)
    filler_rows = rng.sample(range(len(sensors.rows)), min(len(sensors.rows), int(len(sensors.rows) * 0.022)))
    for row in filler_rows:
        if row not in corrections and sensors.rows[row][5] is not None and sensors.rows[row][3] not in ['filter', 'cold-1', 'lifesupport']:
            corrections[row] = (round(sensors.rows[row][5] * rng.uniform(0.9, 1.1), 4), '批量复核更正')

    # Q1 answer after corrections (duplicates do not change the median materially but are excluded by definition)
    q1 = [corrections.get(row, (sensors.rows[row][5],))[0] for row in q1_rows if sensors.rows[row][5] is not None]
    answers['Q1'] = round(statistics.median(q1), 4)

    # Assign ids, then add 1% exact duplicates with new ids
    for index, row in enumerate(sensors.rows):
        row[0] = index + 1
    duplicates = [list(sensors.rows[row]) for row in rng.sample(range(len(sensors.rows)), len(sensors.rows) // 100)]
    # Duplicates inside the Q2 series must not create new episodes: the answer counts unique readings only.
    for offset, row in enumerate(duplicates):
        row[0] = len(sensors.rows) + offset + 1
    correction_rows = [(sensors.rows[row][0], value, reason, -rng.randint(1, 400)) for row, (value, reason) in corrections.items()]

    # Q3 confirm calibration reference checks
    references = []
    for n in range(int(300 * max(1, scale))):
        since = rng.randint(0, 380)
        reference = round(rng.uniform(1, 8), 3)
        measured = round(reference * (1 + 0.0004 * since + rng.gauss(0, 0.01)), 4)
        references.append((n + 1, rng.randint(EARLIEST_TICK, -1), 'confirm', since, reference, measured))
    answers['Q3'] = round(statistics.fmean([(m - r) / r for (_, _, _, s, r, m) in references if s <= 100]), 5)

    # Q4 historical light trials per variety (withdrawn experiments must be excluded)
    experiments, q4 = [], {}
    for variety in truth['crops']['varieties']:
        historical_opt = variety['lightOpt'] + rng.uniform(-8, 8)
        means = {}
        for level in range(30, 101, 10):
            values = []
            for rep in range(6):
                growth = variety['r0'] * math.exp(-((level - historical_opt) / variety['lightWidth']) ** 2) + rng.gauss(0, 0.04)
                status = 'completed'
                if rng.random() < 0.08:
                    status, growth = 'withdrawn', growth + rng.uniform(0.3, 0.6)
                else:
                    values.append(growth)
                experiments.append((f'light-trial-v{variety["variety"]}-{level}-{rep + 1}', rng.randint(-40000, -2000), f'variety-{variety["variety"]}',
                                    'light-trial', status, json.dumps({'variety': variety['variety'], 'light': level, 'growthIndex': round(growth, 4)})))
            means[level] = statistics.fmean(values) if values else -1
        q4[f'variety-{variety["variety"]}'] = max(means, key=means.get)
    answers['Q4'] = q4

    # Q5 lot quality control history; lots table maps lots to production sols
    lots = truth['lots']
    production = {'A1': -212 - rng.randint(5, 30), 'A2': -212, 'A3': -212 + rng.randint(5, 30), 'B': -150, 'medium': -140}
    lot_rows = [(lots[key], 'extraction' if key != 'medium' else 'medium', key, production[key], production[key] * 96 + rng.randint(200, 900),
                 12 if key.startswith('A') else 40 if key == 'B' else 12) for key in lots]
    fail_rate = {'A1': rng.uniform(0.01, 0.05), 'A2': rng.uniform(0.18, 0.3), 'A3': rng.uniform(0.01, 0.05), 'B': rng.uniform(0.01, 0.05)}
    qc_rows, q5 = [], {}
    for key in ['A1', 'A2', 'A3', 'B']:
        results = [0 if rng.random() < fail_rate[key] else 1 for _ in range(int(80 * max(1, scale)))]
        q5[lots[key]] = round(1 - statistics.fmean(results), 4)
        qc_rows.extend((None, lots[key], rng.randint(-20000, -100), passed) for passed in results)
    answers['Q5'] = q5
    qc_rows = [(index + 1, lot, tick, passed) for index, (_, lot, tick, passed) in enumerate(qc_rows)]

    # Q8 past contamination incidents with revised post-mortems
    incidents, latest = [], []
    for n in range(int(12 * max(1, scale ** 0.5))):
        cause = rng.choices(['seal', 'inlet', 'membrane'], [0.4, 0.35, 0.25])[0]
        tick = rng.randint(EARLIEST_TICK, -300)
        if rng.random() < 0.3:
            first = rng.choice([c for c in ['seal', 'inlet', 'membrane'] if c != cause])
            incidents.append((f'INC-{n + 1:03}', 1, tick, 'water-contamination', first, '初步判断', 'superseded'))
            incidents.append((f'INC-{n + 1:03}', 2, tick + rng.randint(20, 200), 'water-contamination', cause, '复盘修订', 'final'))
        else:
            incidents.append((f'INC-{n + 1:03}', 1, tick, 'water-contamination', cause, '复盘', 'final'))
        latest.append(cause)
        if rng.random() < 0.5:
            incidents.append((f'INC-P{n + 1:03}', 1, tick - rng.randint(10, 400), 'power', 'dust-storm', '沙尘暴限电', 'final'))
    answers['Q8'] = round(latest.count('seal') / len(latest), 4)

    return sensors.rows + duplicates, correction_rows, references, experiments, lot_rows, qc_rows, incidents, maintenance_extra, answers


DOCUMENTS = [
    ('SOP-CONF', 1, 'obsolete', 'confirm 色谱积分规程 v1', 'DOC 峰位于保留时间 5.1 分钟附近。在 4.8–5.6 分钟窗口内对信号直接求和积分，乘以响应因子 1.0 得到浓度 mg/L。7.8 分钟内标峰面积用于进样量检查。'),
    ('SOP-CONF', 2, 'active', 'confirm 色谱积分规程 v2', '先以 0–4 分钟与 9–12 分钟区段线性拟合扣除基线，再在 4.6–6.2 分钟对重叠峰做双高斯拟合。DOC 峰中心 5.10 分钟、宽度约 0.12；若在 5.40 分钟附近存在宽度约 0.15 的第二峰，它不属于 DOC。DOC 浓度 = DOC 峰面积 / 内标峰面积 × 内标浓度系数 10。仪器摘要值仍按 v1 窗口计算，仅供参考。'),
    ('MEMO-LUB', 1, 'active', '泵封维护备忘', '泵封磨损时会有润滑剂渗入出水，色谱中在 5.4 分钟附近出现与 DOC 峰部分重叠的宽峰。历史上此特征只出现在 pump 出口样品。'),
    ('MEMO-CLOCK', 1, 'active', '时钟迁移说明', f'tick {MIGRATION_TICK} 之前的历史记录只有地球时间戳（earth_ts, UTC）。换算：tick = {MIGRATION_TICK} + (地球秒数 − {MIGRATION_EARTH}) / {TICK_SECONDS:.4f}。1 sol = {SOL_SECONDS} 秒 = 96 tick。旧生命支持子系统温度单位为华氏度，流量单位为 mL/min。'),
    ('MEMO-CORR', 1, 'active', '数据更正规则', 'corrections 表中的 corrected_value 取代 sensors 中同 record_id 的原值。quality=missing 的记录不参与统计。约 1% 记录因归档重复写入，tick、实体、指标与数值完全相同，应去重。'),
    ('DS-BATT', 1, 'active', '电池组数据表', '标称容量 800 单位，最大充放电功率每步 20 单位。容量会随循环衰减，实际值需由运行数据确定。'),
    ('SOP-PANEL', 1, 'active', '太阳能面板清洁规程', '火星尘埃持续沉积使面板输出缓慢下降。由 R3 执行 panel_clean，每次 10 步。清洁后输出恢复至峰值。大气不透明度 tau_dust 上升通常预示沙尘暴。'),
    ('GUIDE-PATH', 1, 'active', '作物病害识别指南', '潜伏期病株在高光谱图像中，病斑像素的第 6 波段与第 4 波段比值比健康叶面高 15%–25%，病斑约占叶面像素 3%–8%，整株平均几乎不可见。病原检测链：crop_sample → separate → extract → confirm（病原通道）。移除病株或隔离舱室可阻断传播；运送过病株样品的机器人应消毒。'),
    ('GUIDE-DRIFT', 1, 'active', '舱室传感器漂移先例', '历史上舱室温度或湿度传感器曾出现线性漂移，速率约每步 0.02–0.05。只有 device_reference 参考测量能给出真实值。校准传感器使用 sensor_calibrate。'),
    ('SOP-STORE', 1, 'active', '样品保存规程', '水样中的 DOC 会降解，常温下明显快于冷藏与冷冻。采样后应尽快冷藏；长距离运输使用 R2 保温箱。'),
    ('MEMO-SEAL', 1, 'active', '舱体密封检查', '每个温室舱有门、风管、面板三个密封点。seal_inspect 逐点检查，seal_repair 使用一份密封胶修复。'),
    ('MEMO-WEAR', 1, 'active', '设备磨损监测', '离心机振动 RMS、检测与成像光源强度、加热器升温时间、R1 电机电流随磨损单调变化。device_service 预防维护消耗对应备件；故障后维修耗时约为预防维护的三倍。'),
]
LITERATURE = [
    ('CO2 饱和常数', 'K_C 约 150 ppm，提高 CO2 至 1500 ppm 几乎无增益。', True),
    ('DOC 常温降解', '常温下 DOC 每 100 步损失不足 2%，无需冷藏。', True),
    ('光照与舱温', '光照变化对舱温没有可测影响。', True),
    ('营养档位', '营养档 3 对所有品种都是最优。', True),
    ('沙尘暴预兆', '沙尘暴前大气不透明度没有可观测变化。', True),
    ('电池衰减', '电池实际容量始终等于标称容量。', True),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=pathlib.Path, required=True)
    parser.add_argument('--truth', type=pathlib.Path, required=True)
    parser.add_argument('--answers', type=pathlib.Path, required=True)
    args = parser.parse_args()
    truth = json.loads(args.truth.read_text())
    scale = truth['settings']['archiveScale']
    rng = random.Random(truth['seed'] * 7919 + 17)
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / 'history.sqlite'
    if path.exists():
        parser.error('History already exists; retain the original dataset')
    sensors, corrections, references, experiments, lots, qc, incidents, failures, answers = build(truth, rng, scale)
    db = sqlite3.connect(path)
    try:
        db.executescript('''
          CREATE TABLE sensors(id INTEGER PRIMARY KEY,tick INTEGER,earth_ts TEXT,entity_id TEXT,metric TEXT,value REAL,unit TEXT,quality TEXT);
          CREATE TABLE corrections(record_id INTEGER,corrected_value REAL,reason TEXT,revised_tick INTEGER);
          CREATE TABLE maintenance(id INTEGER PRIMARY KEY,tick INTEGER,entity_id TEXT,kind TEXT,detail TEXT);
          CREATE TABLE experiments(id TEXT PRIMARY KEY,tick INTEGER,entity_id TEXT,method TEXT,status TEXT,result TEXT);
          CREATE TABLE documents(id TEXT,tick INTEGER,entity_id TEXT,title TEXT,version INTEGER,status TEXT,body TEXT);
          CREATE TABLE lots(lot_id TEXT PRIMARY KEY,family TEXT,sub_batch TEXT,production_sol INTEGER,received_tick INTEGER,units INTEGER);
          CREATE TABLE lot_qc(id INTEGER PRIMARY KEY,lot_id TEXT,tick INTEGER,passed INTEGER);
          CREATE TABLE reference_checks(id INTEGER PRIMARY KEY,tick INTEGER,device_id TEXT,ticks_since_calibration INTEGER,reference_value REAL,measured_value REAL);
          CREATE TABLE incidents(id TEXT,revision INTEGER,tick INTEGER,kind TEXT,root_cause TEXT,summary TEXT,status TEXT);
          CREATE TABLE chromatograms(id TEXT PRIMARY KEY,tick INTEGER,source TEXT,reference_doc REAL,points TEXT);''')
        db.executemany('INSERT INTO sensors VALUES(?,?,?,?,?,?,?,?)', sensors)
        db.executemany('INSERT INTO corrections VALUES(?,?,?,?)', corrections)
        maintenance = [(index + 1, rng.randint(-60000, -1), rng.choice(['confirm', 'imager', 'cold-1', 'cold-2', 'filter', 'pump', 'robot-1', 'robot-2', 'heater-1', 'centrifuge-1']),
                        rng.choice(['inspection', 'cleaning', 'calibration', 'repair-review']), json.dumps({'note': '例行维护'}, ensure_ascii=False))
                       for index in range(int(50000 * scale))]
        maintenance += [(len(maintenance) + index + 1, tick, entity, kind, detail) for index, (tick, entity, kind, detail) in enumerate(failures)]
        db.executemany('INSERT INTO maintenance VALUES(?,?,?,?,?)', maintenance)
        filler_experiments = [(f'historical-experiment-{index + 1:05}', rng.randint(-60000, -1), rng.choice(['incubator-1', 'confirm', 'imager', 'heater-1']),
                               rng.choice(['culture', 'water-prepare', 'confirm', 'image']), 'withdrawn' if rng.random() < 0.08 else 'completed',
                               json.dumps({'summary': '历史批次'}, ensure_ascii=False)) for index in range(int(1000 * scale))]
        db.executemany('INSERT INTO experiments VALUES(?,?,?,?,?,?)', experiments + filler_experiments)
        documents = [(f'{doc_id}-v{version}', -500 * version, 'base', title, version, status, body) for doc_id, version, status, title, body in DOCUMENTS]
        for index, (title, body, wrong) in enumerate(LITERATURE):
            documents.append((f'LIT-{index + 1:03}', -rng.randint(1000, 30000), 'literature', f'文献笔记：{title}', 1, 'active', body))
        for index in range(len(LITERATURE), 40):
            documents.append((f'LIT-{index + 1:03}', -rng.randint(1000, 30000), 'literature', f'文献笔记 {index + 1}',
                              1, 'active', rng.choice(['作物生长随光照呈单峰响应，最适光照因品种而异。', '冷藏可显著减缓水样中有机物降解。',
                                                       '营养与灌溉存在交互作用，需联合优化。', '面板积尘使发电量缓慢下降，定期清洁可恢复。'])))
        for index in range(int(300 * scale) - len(documents)):
            version = index % 3 + 1
            documents.append((f'sop-{index + 1:04}', -rng.randint(10, 50000), rng.choice(['confirm', 'imager', 'robot-1', 'filter']), f'操作规程 {index + 1}', version,
                              'obsolete' if version < 3 else 'active', '读取当前设备状态与方法版本后执行；历史版本仅作背景。'))
        db.executemany('INSERT INTO documents VALUES(?,?,?,?,?,?,?)', documents)
        db.executemany('INSERT INTO lots VALUES(?,?,?,?,?,?)', lots)
        db.executemany('INSERT INTO lot_qc VALUES(?,?,?,?)', qc)
        db.executemany('INSERT INTO reference_checks VALUES(?,?,?,?,?,?)', references)
        db.executemany('INSERT INTO incidents VALUES(?,?,?,?,?,?,?)', incidents)
        chroma = []
        for index in range(200):
            doc = rng.uniform(0.5, 6)
            lub = rng.uniform(0.5, 2) if rng.random() < 0.2 else 0.0
            points = [round(doc * 0.1 * math.exp(-((t * 0.02 - 5.1) / 0.12) ** 2 / 2) / (0.12 * 2.5066) * 1.0 +
                            lub * 0.1 * math.exp(-((t * 0.02 - 5.4) / 0.15) ** 2 / 2) / (0.15 * 2.5066) +
                            0.1 * math.exp(-((t * 0.02 - 7.8) / 0.2) ** 2 / 2) / (0.2 * 2.5066) + 0.002 * t * 0.02 + rng.gauss(0, 0.01), 4) for t in range(600)]
            chroma.append((f'HC-{index + 1:04}', rng.randint(-40000, -100), 'pump' if lub else rng.choice(['reservoir', 'filter', 'pump']), round(doc, 3), json.dumps(points)))
        db.executemany('INSERT INTO chromatograms VALUES(?,?,?,?,?)', chroma)
        db.executescript('''CREATE INDEX sensor_lookup ON sensors(entity_id,metric,tick);
          CREATE INDEX correction_lookup ON corrections(record_id);
          CREATE INDEX maintenance_lookup ON maintenance(entity_id,tick);
          CREATE INDEX experiment_lookup ON experiments(entity_id,tick);''')
        db.commit()
    finally:
        db.close()
    counts = {'sensors': len(sensors), 'corrections': len(corrections), 'maintenance': len(maintenance), 'experiments': len(experiments) + len(filler_experiments),
              'documents': len(documents), 'lots': len(lots), 'lot_qc': len(qc), 'reference_checks': len(references), 'incidents': len(incidents), 'chromatograms': 200}
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    manifest = {'schemaVersion': 2, 'source': 'simulated-history', 'seed': truth['seed'], 'counts': counts,
                'logicalPosition': f'negative ticks precede mission zero; rows before tick {MIGRATION_TICK} carry only earth_ts',
                'sha256': digest.hexdigest(), 'bytes': path.stat().st_size}
    (directory / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    args.answers.parent.mkdir(parents=True, exist_ok=True)
    args.answers.write_text(json.dumps(answers, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o400)
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == '__main__':
    main()
