<?php
// Standalone: php karta/tests_v2/test_office_receipt_metadata_v2.php (no DB/bootstrap).
require_once __DIR__ . '/../repositories/ReceiptRepository.php';

$note = new ReflectionMethod(ReceiptRepository::class, 'officeRowCreditNote');
if (PHP_VERSION_ID < 80100) $note->setAccessible(true);
$label = 'إضافة رصيد - قيمة كارتة';
foreach ([
    'Arabic name' => ['منى علي', $label . ' منى علي'],
    'empty string' => ['', $label],
    'ordinary spaces' => ['   ', $label],
    'nonbreaking spaces' => ["\u{00A0}\u{00A0}", $label],
    'mixed outer whitespace' => [" \u{00A0}\tمنى  علي\u{00A0} ", $label . ' منى  علي'],
] as $case => [$name, $expected]) {
    if ($note->invoke(null, ['client_name' => $name]) !== $expected) {
        throw new RuntimeException("Incorrect office credit note: $case");
    }
    echo "PASS: $case\n";
}

// Guard the GET's choice of read path, then exercise that path without a connection.
$get = file_get_contents(__DIR__ . '/../api/entities/receipts/get.php');
if (!str_contains($get, 'ReceiptRepository::findByIdReadOnly(getDB(), $id)') || str_contains($get, 'new ReceiptRepository')) {
    throw new RuntimeException('Receipt GET must not construct a schema-preparing repository');
}
$db = new class extends PDO {
    public array $sql = [];
    public function __construct() {}
    public function query(string $query, ?int $fetchMode = null, ...$args): PDOStatement|false {
        $this->sql[] = $query;
        return false;
    }
    public function exec(string $statement): int|false {
        $this->sql[] = $statement;
        return 0;
    }
    public function prepare(string $query, array $options = []): PDOStatement {
        $this->sql[] = $query;
        return new class extends PDOStatement {
            public function execute(?array $params = null): bool {
                if ($params !== [':id' => 41]) throw new RuntimeException('Wrong receipt ID binding');
                return true;
            }
            public function fetch(int $mode = PDO::FETCH_DEFAULT, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed {
                return ['id' => 41, 'client_name' => 'منى علي', 'rows' => '[]']; // legacy: no payment_status column
            }
        };
    }
};
$record = ReceiptRepository::findByIdReadOnly($db, 41);
if ($db->sql !== ['SELECT * FROM receipts WHERE id = :id AND deleted_at IS NULL LIMIT 1']
    || $record !== ['id' => 41, 'client_name' => 'منى علي', 'rows' => [], 'payment_status' => 'unpaid']) {
    throw new RuntimeException('Receipt GET must only SELECT and normalize the existing record in memory');
}
echo "PASS: read-only receipt GET lookup\n";
