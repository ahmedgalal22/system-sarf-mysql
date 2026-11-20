"""Opt-in native PDO/HTTP parity test. Run as an unprivileged Linux user:
    python3 karta/tests_v2/run_owner_list_mariadb.py
Requires unshare (user/net namespaces), ip, mariadb-install-db, mariadbd, PHP CLI
with pdo_mysql + sessions, and Node on PATH. Runs parity, interleaving, then a
warm-up + three measured summary GETs per scale fixture (median; private slow log).
No DSN, host, port, existing data path or application database credentials are
accepted. Fail if isolation fails.
"""
import contextlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
from statistics import median
import subprocess as sp
import sys
import tempfile
import time

KARTA = Path(__file__).resolve().parents[1]
READS = ('entities/vehicleOwners/list.php', 'entities/vehicleOwners/list-summary.php', 'entities/vehicle-ledger/list.php')


# All load measurements use deterministic values/IDs, never an existing ledger.
SCALE = {'single1k': (610, 1024), 'single8k': (611, 8192), 'single64k': (612, 65536), 'distinct32k': (613, 32768),
         'precision1k': (614, 1024), 'precision8k': (615, 8192), 'activity4k': (616, 4096)}


def scale_fixture(owner):
    sql = []
    day = "'2026-06-20'"
    wall = "'2026-06-20 09:00:00'"

    def history(i, user, size, amount='1', date=day, applied=wall, kind="'deposit'"):
        if not size:
            return
        digits = '(SELECT 0 d ' + ' '.join(f'UNION ALL SELECT {d}' for d in range(1, 10)) + ')'
        places = range(len(str(size - 1)))
        n = '+'.join(f'{10**k}*t{k}.d' for k in places)
        seq = ' CROSS JOIN '.join(f'{digits} t{k}' for k in places)
        start = i * (5000 if user == 'volume' else 100000)
        sql.append('INSERT INTO vehicle_ledger(id,uuid,username,client_type,client_id,type,amount,date,applied_at,created_at) '
                   f"SELECT {start}+n,CONCAT('load-{i}-',n),'{user}','owner','{i}',{kind},{amount},{date},{applied},{wall} "
                   f'FROM (SELECT {n} n FROM {seq}) seq WHERE n<{size}')

    for i in range(501, 506):
        owner(i, 'volume', name='' if i == 505 else str(i), kind='broker' if i == 504 else 'owner')
        history(i, 'volume', 4096, amount='IF(n=0,9223372036854775807,1)' if i == 502 else '1',
                date='NULL' if i == 503 else day)
    for user, (i, size) in SCALE.items():
        owner(i, user)
        if user.startswith('precision'):
            history(i, user, size, amount=f'IF(n={size-1},9007199254740993,1)')
        elif user == 'activity4k':  # cannot collapse the DISTINCT time keys
            history(i, user, size, date='NULL', applied="CONCAT('2026-06-20 ',SEC_TO_TIME(n))")
        else:
            history(i, user, size, applied='NULL', amount='(n-16384)' if user == 'distinct32k' else '1')
    kinds = "ELT(1+MOD(n,8),'deposit','withdraw','receipt_due','receipt_payment','OFFICE_DEPOSIT','OFFICE_WITHDRAW_AUTO','new','DEPOSIT')"
    for j in range(64):
        i, mode = 700 + j, j % 8
        size = (0, 1, 7, 33, 128, 257, 513, 1024)[mode]
        # Strict JS eligibility: whitespace is a name; uppercase/trailing spaces are not literal broker.
        owner(i, 'mixed', name=' ' if mode == 1 else str(i), kind=('broker ', 'BROKER')[j % 2])
        cents = 'ELT(1+MOD(n DIV 8,3),37,-37,0)'
        if mode in (5, 6):  # overflow late, retain even the earlier small or ignored legs
            cents = f'IF(n={size - 1},9007199254740993,{cents})'
        history(i, 'mixed', size, kind=kinds, amount=cents,
                date="IF(MOD(n,4)=0,'2026-05-01',NULL)" if mode in (3, 6, 7) else day,
                applied="ELT(1+MOD(n,3),'2026-06-20 09:00:00',' 2026-06-20T18:30:00Z','invalid')")
    return sql


def fixture(password, writer_password):
    sql = ["CREATE DATABASE owner_list_fixture CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", 'USE owner_list_fixture']
    for table in ('vehicle_owners', 'vehicle_ledger'):
        # Only the indicated CREATE TABLE, never the installation's USE or migrations.
        ddl = (KARTA / f'database_{table}.sql').read_text().split(f'CREATE TABLE IF NOT EXISTS {table} (', 1)[1]
        ddl = ' '.join(line.split('--')[0].strip() for line in ddl.splitlines()).strip().removesuffix(';')
        if ';' in ddl or not ddl.endswith('COLLATE=utf8mb4_unicode_ci'):
            raise ValueError('Unexpected fixture DDL')
        sql.append(f'CREATE TABLE {table} (' + ddl)
    def insert(table, **fields):
        values = ','.join('NULL' if v is None else "'" + str(v).replace("'", "''") + "'" for v in fields.values())
        sql.append(f"INSERT INTO {table} ({','.join(fields)}) VALUES ({values})")
    def owner(i, user='alpha', name=None, kind='owner', deleted=None):
        insert('vehicle_owners', id=i, uuid=f'o-{i}', username=user, name=str(i) if name is None else name,
               owner_type=kind, deleted_at=deleted, created_at=f'2026-01-01 00:00:00.{len(sql):03}')
    entry_id = 0
    def leg(client, kind, amount, **patch):
        nonlocal entry_id
        entry_id += 1
        fields = dict(id=entry_id, uuid=f'e-{entry_id}', username='alpha', client_id=client, client_type='owner',
                      type=kind, amount=amount, date='2026-06-01', created_at='2026-06-01 09:30:00.123')
        insert('vehicle_ledger', **(fields | patch))
    for i in (1, 2, 3, 4, 5, 6, 7, 13, 4294967295):
        owner(i)
    owner(8, name='0', kind='BROKER'); owner(9, 'beta'); owner(10, kind='broker')
    owner(11, deleted='2026-01-02'); owner(12, name='')
    leg(2, 'deposit', 341); leg(2, 'withdraw', 341); leg(3, 'unknown', 50)
    for amount, day in [(2**53, 3), (1, 2), (-2**53, 1)]:
        leg(4, 'deposit', amount, date=f'2026-06-0{day}')
    leg(5, 'deposit', 10**15); leg(6, 'deposit', 10**15); leg(6, 'withdraw', 1)
    leg('7', 'deposit', 25); leg('7 ', 'deposit', 50, client_type='OWNER')
    for client, patch in [('07', {}), ('7x', {}), (None, {'vehicle_owner_id': '7'}), ('7', {'client_type': 'office'}),
                          ('7', {'client_type': 'mandoub'}), ('7', {'is_reversed': 1}), ('7', {'deleted_at': '2026-06-02'}),
                          ('7', {'username': 'beta'}), ('9', {}), ('9', {'client_type': 'office', 'username': 'beta'})]:
        leg(client, 'deposit', 77777, **patch)
    leg(9, 'withdraw', 123, username='beta'); leg(10, 'deposit', 700); leg(11, 'deposit', 900)
    leg(4294967295, 'deposit', 101); leg('04294967295', 'deposit', 999)
    leg(13, 'deposit', 1, applied_at='2026-06-01 20:30:00')
    leg(13, 'unknown', 9, id=4294967295, date=None, applied_at='2026-06-01T18:30:00Z')
    i = 20
    for kind in ('deposit', 'withdraw', 'receipt_due', 'receipt_payment', 'OFFICE_DEPOSIT', 'OFFICE_WITHDRAW_AUTO', 'other', 'DEPOSIT'):
        for c in (37, -37, 0):
            owner(i); leg(i, kind, c); i += 1
    for c in (2**63-1, -2**63, 2**53-1, 2**53, 2**53+1, -(2**53-1), -2**53, -(2**53+1)):
        owner(i); leg(i, 'deposit', c); i += 1
    owner(810, 'edge'); owner(811, 'edge')
    for j, stamp in enumerate(('2026-06-20T18:30:00Z', '2026-06-20T18:30:00Z', '2026-06-20t18:30:00z', '2026-06-20T18:30:00Z ')):
        leg(810, 'unknown', 0, id=810100+j, username='edge', date=None, applied_at=stamp)
    leg(811, 'deposit', 10**15, username='edge'); leg(811, 'withdraw', 10**15, username='edge')
    for i, date, applied in [(812, None, ''), (813, '0000-00-00', '2026-06-22 09:00:00'),
                             (814, None, '0'), (815, None, ' ')]:
        owner(i, 'edge'); leg(i, 'deposit', 0, username='edge', date=date, applied_at=applied, created_at='2026-06-21 11:02:03.456')
    sql.extend(scale_fixture(owner))
    sql += [f"CREATE USER 'list_reader'@'localhost' IDENTIFIED BY '{password}'",
            "GRANT SELECT ON owner_list_fixture.* TO 'list_reader'@'localhost'",
            f"CREATE USER 'interleave'@'localhost' IDENTIFIED BY '{writer_password}'",
            "GRANT INSERT ON owner_list_fixture.vehicle_ledger TO 'interleave'@'localhost'"]
    return sql


@contextlib.contextmanager
def service(argv, ready, log, env):
    with log.open('wb') as out:
        p = sp.Popen(argv, cwd=log.parent, env=env, stdout=out, stderr=out)
        try:
            end = time.monotonic() + 120
            while ready not in log.read_bytes():
                if p.poll() is not None or time.monotonic() > end:
                    raise RuntimeError(f'{argv[0]} not ready: {log.read_text()[-2400:]}')
                time.sleep(.05)
            yield
        finally:
            p.terminate()
            try:
                p.wait(timeout=15)
            except sp.TimeoutExpired:
                p.kill(); p.wait()


def measure(tmp, cookies):
    """Per-request server counters from the private MariaDB slow log, NOT EXPLAIN estimates."""
    peak = tmp/'peak'
    results = {}
    for user in (*SCALE, 'volume', 'mixed'):
        samples = []
        for _ in range(4):  # one warm-up, then three measured requests
            peak.unlink(missing_ok=True)
            with (tmp/'slow.log').open() as log, contextlib.closing(http.client.HTTPConnection('127.0.0.1', 18748, timeout=60)) as conn:
                log.seek(0, 2)
                start = time.monotonic()
                conn.request('GET', '/api/entities/vehicleOwners/list-summary.php', headers={'Cookie': 'KARTA_V2_SESSION=' + cookies[user]})
                response = conn.getresponse(); body = response.read()
                ms = (time.monotonic() - start) * 1000
                if response.status != 200 or json.loads(body)['success'] is not True:
                    raise RuntimeError('Summary GET failed during measurement')
                # Each statement record has counters followed by its SQL (only this one client is active).
                selects = [r for r in log.read().split('# User@Host:') if re.search(r'^SELECT ', r, re.M)]
            if not selects or not all('vehicle_' in r for r in selects):
                raise RuntimeError('Missing or unexpected data SELECT in slow log')
            def counters(name, rows):
                return [re.search(r'\b' + name + r': ([0-9.]+)', r)[1] for r in rows]
            ledger = [r for r in selects if 'vehicle_ledger' in r]
            heap, session = json.loads(peak.read_text())
            samples.append(dict(read=int(session['Rows_read']), selects=len(selects), examined=sum(map(int, counters('Rows_examined', selects))),
                                rows=sum(map(int, counters('Rows_sent', selects))), ledger_rows=sum(map(int, counters('Rows_sent', ledger))),
                                db_bytes=int(session['Bytes_sent']), http_bytes=len(body), php_peak=heap,
                                sql_ms=1000 * sum(map(float, counters('Query_time', selects))), http_ms=ms))
        stats = {k: round(median(s[k] for s in samples[1:]), 3) for k in samples[0]}
        print('MEASURE', user, json.dumps(stats), flush=True)
        results[user] = stats
    # Guard scaling, not a machine-specific latency or an exact PHP allocator baseline.
    if results['single64k']['php_peak'] > results['single1k']['php_peak'] + 512 * 1024:
        raise RuntimeError('Ordinary ledger retained history in PHP')
    if results['volume']['ledger_rows'] >= 20480 or results['mixed']['selects'] > 4:
        raise RuntimeError('Excluded ledger rows or per-owner queries regressed')


def verify(tmp):
    env = dict(PATH=os.environ['PATH'], HOME=str(tmp), TMPDIR=str(tmp), LC_ALL='C')
    def run(*args, **kwargs):
        return sp.run(args, cwd=tmp, env=env, check=True, **kwargs)
    www, data, sock = tmp/'www', tmp/'data', tmp/'db.sock'
    data.mkdir(mode=0o700)
    # Copy the actual three read endpoints and their bootstrap only. No posting endpoints.
    paths = ['api/' + p for p in READS] + ['api/middleware/auth.php', 'config/app.php', 'config/session.php']
    paths += ['core/' + n + '.php' for n in ('bootstrap', 'helpers', 'json', 'security', 'response')]
    paths += ['repositories/' + n + '.php' for n in ('VehicleOwnerRepository', 'VehicleLedgerRepository', 'VehicleOwnerListRepository')]
    for name in paths:
        (www/name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(KARTA/name, www/name)
    (www/'logs').mkdir(); sessions = www/'storage/sessions'; sessions.mkdir(parents=True)
    password, writer_password = secrets.token_hex(24), secrets.token_hex(24)
    (www/'config/database.php').write_text("<?php return ['host'=>'localhost','port'=>0,'dbname'=>'owner_list_fixture',"
        f"'username'=>'list_reader','password'=>'{password}', 'charset'=>'utf8mb4', 'options'=>["
        "PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC,"
        "PDO::ATTR_EMULATE_PREPARES=>false,(defined('Pdo\\\\Mysql::ATTR_INIT_COMMAND') ? "
        "Pdo\\Mysql::ATTR_INIT_COMMAND : PDO::MYSQL_ATTR_INIT_COMMAND)=>'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci']];")
    init = tmp/'init.sql'; init.write_text(';\n'.join(fixture(password, writer_password)) + ';\n')
    cookies = {name: secrets.token_hex(20) for name in ('alpha', 'beta', 'nobody', 'volume', *SCALE, 'mixed', 'edge')}
    for user_id, (name, sid) in enumerate(cookies.items(), 1):
        run('php', '-d', f'session.save_path={sessions}', '-r',
            'session_id($argv[1]); session_start(); $_SESSION=["logged_in"=>true,"username"=>$argv[2],'
            '"user_id"=>(int)$argv[3],"role"=>"accountant","last_activity_at"=>time()]; session_write_close();', sid, name, str(user_id))
    private = ['--no-defaults', f'--datadir={data}', f'--socket={sock}', f'--tmpdir={tmp}', '--skip-networking']
    run('mariadb-install-db', *private, '--skip-test-db', '--auth-root-authentication-method=normal', stdout=sp.DEVNULL, timeout=90)
    php = ['php', '-d', f'pdo_mysql.default_socket={sock}']
    with service(['mariadbd', *private, '--skip-name-resolve', f'--pid-file={tmp}/db.pid', f'--init-file={init}',
                  '--innodb-buffer-pool-size=64M', '--slow-query-log', f'--slow-query-log-file={tmp}/slow.log',
                  '--long-query-time=0', '--log-slow-verbosity=query_plan',
                  '--sql-mode=STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY'], b'ready for connections', tmp/'maria.log', env):
        # Verify process identity/transport and actual native PDO types before reading balances.
        meta = run(*php, '-r', '''$c=require $argv[1]; $db=new PDO('mysql:host=localhost;dbname=owner_list_fixture;charset=utf8mb4',
            $c['username'],$c['password'],$c['options']); $x=$db->query("SELECT @@datadir d, @@socket s, @@skip_networking n,
            @@collation_connection col,VERSION() v")->fetch(); $st=$db->prepare('SELECT amount,CAST(amount AS CHAR) txt FROM vehicle_ledger
            WHERE client_id=:id AND username=:u');$st->execute([':id'=>'44',':u'=>'alpha']);$row=$st->fetch();
            echo json_encode([$x,PHP_VERSION,PHP_INT_SIZE*8,$db->getAttribute(PDO::ATTR_CLIENT_VERSION),
            $db->getAttribute(PDO::ATTR_EMULATE_PREPARES),gettype($row['amount']),$row['txt'],gettype($row['txt'])]);''',
            www/'config/database.php', stdout=sp.PIPE, text=True)
        info, version, bits, client, emulation, raw_type, text, cast_type = json.loads(meta.stdout)
        if (Path(info['d']).resolve(), info['s'], int(info['n']), info['col']) != (data, str(sock), 1, 'utf8mb4_unicode_ci'):
            raise RuntimeError('Unexpected test database identity')
        if emulation or text != str(2**63-1) or cast_type != 'string':
            raise RuntimeError('Unexpected native prepare or BIGINT conversion')
        print(info['v'], 'PHP', version, bits, client, info['col'], 'BIGINT:', raw_type, 'CAST:', cast_type, text, flush=True)
        run(*php, KARTA/'tests_v2/fixtures/owner_list_read_view.php', os.readlink('/proc/self/ns/net'),
            input=writer_password, text=True, timeout=30)
        # Capture managed peak first, then session counters after the actual GET SQL and JSON.
        probe = tmp/'peak.php'
        probe.write_text("<?php if ($_SERVER['SCRIPT_NAME'] === '/api/entities/vehicleOwners/list-summary.php') "
                         "register_shutdown_function(static function(){if(http_response_code()!==200)return; "
                         "$peak=memory_get_peak_usage(false); $status=getDB()->query(\"SHOW SESSION STATUS WHERE Variable_name IN "
                         "('Rows_read','Bytes_sent')\")->fetchAll(PDO::FETCH_KEY_PAIR); "
                         "file_put_contents(dirname($_SERVER['DOCUMENT_ROOT']).'/peak',json_encode([$peak,$status]));});")
        # The unmodified reference GET fetches SELECT * for the 65,536-row ledger.
        with service([*php, '-d', 'memory_limit=512M', '-d', f'auto_prepend_file={probe}', '-S', '127.0.0.1:18748', '-t', www], b'Development Server', tmp/'http.log', env):
            run('node', str(KARTA/'tests_v2/fixtures/owner_list_mariadb.mjs'), os.readlink('/proc/self/ns/net'),
                input=json.dumps(cookies), text=True, timeout=180)
            measure(tmp, cookies)


if __name__ == '__main__':
    if os.geteuid() == 0:
        sys.exit('Run as a non-root user; do not use sudo.')
    if len(sys.argv) == 1:
        sys.exit(sp.call(['unshare', '--user', '--map-current-user', '--keep-caps', '--net', '--', sys.executable, '-I', '-B',
                          __file__, os.readlink('/proc/self/ns/net')]))
    if len(sys.argv) != 2 or os.readlink('/proc/self/ns/net') == sys.argv[1] or [i[1] for i in socket.if_nameindex()] != ['lo']:
        sys.exit('Private loopback-only network namespace required.')
    sp.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(dir='/tmp', prefix='karta-owner-fixture-') as d:
        verify(Path(d))
