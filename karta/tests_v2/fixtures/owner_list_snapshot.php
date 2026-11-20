<?php
// Cross-language test fixture. No application bootstrap, session, DSN or files.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/../../repositories/VehicleOwnerListRepository.php';

final class OwnerListTestStatement extends PDOStatement {
    private object $counter;
    protected function __construct(object $counter) { $this->counter = $counter; }
    public function execute(?array $params = null): bool {
        if (stripos(ltrim($this->queryString), 'SELECT') === 0) ++$this->counter->reads;
        return parent::execute($params);
    }
}
$fixture = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$db->exec('CREATE TABLE vehicle_owners (id INTEGER PRIMARY KEY, username TEXT, name TEXT, phone TEXT, owner_type TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)');
// Keep BIGINT literals lossless in this portable fixture. Include the *distinct* vehicle owner key.
$db->exec('CREATE TABLE vehicle_ledger (id INTEGER PRIMARY KEY, username TEXT, client_id TEXT COLLATE RTRIM, client_type TEXT COLLATE NOCASE, vehicle_owner_id TEXT, type TEXT, amount TEXT, date TEXT, applied_at TEXT, created_at TEXT, deleted_at TEXT, is_reversed INTEGER)');
foreach (['owners' => 'vehicle_owners', 'ledger' => 'vehicle_ledger'] as $key => $table) {
    $columns = $db->query("PRAGMA table_info($table)")->fetchAll(PDO::FETCH_COLUMN, 1);
    $insert = $db->prepare("INSERT INTO $table VALUES (:" . implode(', :', $columns) . ')');
    foreach ($fixture[$key] as $record) $insert->execute($record);
}
$counter = (object)['reads' => 0];
$db->setAttribute(PDO::ATTR_STATEMENT_CLASS, [OwnerListTestStatement::class, [$counter]]);
$db->exec('PRAGMA query_only = ON');
$db->beginTransaction();
try {
    $summary = (new VehicleOwnerListRepository($db))->getForUser('alpha');
} catch (UnexpectedValueException $err) {
    $db->rollBack();
    echo json_encode(['error' => $err->getMessage()], JSON_THROW_ON_ERROR);
    exit;
}
$reads = $counter->reads;
// Reference input for the unmodified FinancialService (same predicates/order as the old GET).
$owners = (new VehicleOwnerRepository($db))->getAllByUsername('alpha');
$ledger = [];
$oldGet = $db->prepare("SELECT * FROM vehicle_ledger WHERE username = :u AND deleted_at IS NULL AND client_id = :cid AND client_type = 'owner' AND is_reversed = 0 ORDER BY date DESC, created_at DESC");
foreach ($owners as $o) {
    $oldGet->execute([':u' => 'alpha', ':cid' => (string)$o['id']]);
    $ledger[$o['id']] = $oldGet->fetchAll();
}
$db->commit();
echo json_encode(compact('summary', 'reads', 'owners', 'ledger'), JSON_THROW_ON_ERROR);
