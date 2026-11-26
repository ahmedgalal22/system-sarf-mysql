<?php
// Exercise the real search-options builder with synthetic PDO results only.
require_once __DIR__ . '/../repositories/ReceiptRepository.php';

class KartaOptionsStatement extends PDOStatement {
    private array $rows;
    private int $position = 0;

    public function __construct(array $rows) { $this->rows = $rows; }
    public function execute(?array $params = null): bool { return true; }
    public function fetchAll(int $mode = PDO::FETCH_DEFAULT, mixed ...$args): array { return []; }
    public function fetch(int $mode = PDO::FETCH_DEFAULT, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed {
        return $this->rows[$this->position++] ?? false;
    }
}

class KartaOptionsPDO extends PDO {
    private array $rows;
    public function __construct(array $rows) { $this->rows = $rows; }
    public function prepare(string $query, array $options = []): PDOStatement|false {
        return new KartaOptionsStatement(str_contains($query, 'SELECT `rows`') ? [['rows' => json_encode($this->rows)]] : []);
    }
}

$cases = [
    'empty primary' => [['kartano' => '', 'kartaNo' => '  00101  ', 'karta' => 'ignored'], '00101'],
    'whitespace primary' => [['kartano' => " \t\n", 'kartaNo' => 'legacy'], 'legacy'],
    'unicode whitespace primary' => [['kartano' => "\u{00A0}\u{2003}", 'kartaNo' => 'legacy'], 'legacy'],
    'unicode whitespace secondary' => [['kartano' => '', 'kartaNo' => "\u{00A0}", 'karta' => 'final'], 'final'],
    'primary priority' => [['kartano' => ' primary ', 'kartaNo' => 'secondary', 'karta' => 'tertiary'], 'primary'],
    'third alias' => [['kartano' => '', 'kartaNo' => " \t", 'karta' => ' final '], 'final'],
    'zero primary retains priority' => [['kartano' => 0, 'kartaNo' => 'ignored'], 0],
    'zero secondary retains priority' => [['kartano' => '', 'kartaNo' => '0', 'karta' => 'ignored'], 0],
    'no value' => [['kartano' => ' ', 'kartaNo' => '', 'karta' => ' '], null],
];
$method = new ReflectionMethod(ReceiptRepository::class, '_buildSearchOptions');
foreach ($cases as $name => [$row, $expected]) {
    $repo = new ReceiptRepository(new KartaOptionsPDO([$row]));
    $options = $method->invoke($repo, 'synthetic-user', null, null);
    $expectedValues = $expected === null ? [] : [$expected];
    if ($options['kartas'] !== $expectedValues) {
        throw new RuntimeException("$name: " . json_encode($options['kartas']) . ' != ' . json_encode($expectedValues));
    }
    echo "PASS: $name\n";
}
