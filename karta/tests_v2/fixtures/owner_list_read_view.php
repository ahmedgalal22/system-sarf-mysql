<?php
// Native fixture only. A second connection commits AFTER the compact scan, just before
// replay starts. The normal HTTP endpoint has no access to this fixture-only writer.
$t = getcwd();
if (PHP_SAPI !== 'cli' || ($argv[1] ?? '') !== readlink('/proc/self/ns/net') ||
    !preg_match('~^/tmp/karta-owner-fixture-[\w-]+$~D', $t) || !is_dir("$t/data")) exit(2);
require "$t/www/repositories/VehicleOwnerListRepository.php";
$c = require "$t/www/config/database.php";
$dsn = "mysql:unix_socket=$t/db.sock;dbname=owner_list_fixture;charset=utf8mb4";
$db = new PDO($dsn, $c['username'], $c['password'], $c['options']);
$writer = new PDO($dsn, 'interleave', stream_get_contents(STDIN), $c['options']);
foreach ([$db, $writer] as $conn) {
    $r = $conn->query('SELECT @@datadir d, @@socket s, @@skip_networking n')->fetch();
    if (realpath($r['d']) !== "$t/data" || $r['s'] !== "$t/db.sock" || (int)$r['n'] !== 1) exit(3);
}
final class CommitBeforeReplay extends PDOStatement {
    public static ?PDO $writer = null;
    public static int $selects = 0;
    protected function __construct() {}
    public function execute(?array $params = null): bool {
        if (str_starts_with($this->queryString, 'SELECT') && ++self::$selects === 3 && self::$writer !== null) {
            self::$writer->exec("INSERT INTO vehicle_ledger (id,uuid,username,client_id,client_type,type,amount,date) VALUES
                (910001,'new-precision','edge','811','owner','deposit',37,'2026-06-30'),
                (910002,'new-activity','edge','810','owner','deposit',0,'2026-06-30')");
            self::$writer = null;
        }
        return parent::execute($params);
    }
}
$db->setAttribute(defined('Pdo\\Mysql::ATTR_USE_BUFFERED_QUERY') ? Pdo\Mysql::ATTR_USE_BUFFERED_QUERY : PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
$db->setAttribute(PDO::ATTR_STATEMENT_CLASS, [CommitBeforeReplay::class, []]);
$read = static function () use ($db) {
    $db->exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'); $db->beginTransaction();
    $rows = (new VehicleOwnerListRepository($db))->getForUser('edge'); $db->commit();
    return array_column($rows, 'summary', 'id');
};
CommitBeforeReplay::$writer = $writer;
$old = $read();
$ids = static function ($rows) { $ids = array_map('intval', array_column($rows, 'id')); sort($ids); return $ids; };
if (CommitBeforeReplay::$writer !== null || CommitBeforeReplay::$selects !== 4 || count($old[811]['precision_entries']) !== 2 ||
    $ids($old[810]['activity']) !== [810101, 810102, 810103]) throw new RuntimeException('Incorrect in-flight replay/timestamp ties');
$fresh = $read();
if (!in_array(910001, $ids($fresh[811]['precision_entries']), true) || count($fresh[811]['precision_entries']) !== 3 ||
    $fresh[810]['activity'] !== '2026-06-30') throw new RuntimeException('New transaction did not see both committed rows');
echo "PASS: both replays kept the first read view; the next transaction saw +37 cents and the newer activity.\n";
