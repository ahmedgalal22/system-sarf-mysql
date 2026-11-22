<?php
// Standalone contract test: no bootstrap, session, database connection or HTTP.
require_once __DIR__ . '/../core/allFormsSearchDates.php';

$cases = [
    'absent' => [[], null, null],
    'unrelated filters' => [['client_name' => ['Ahmed'], 'limit' => 0], null, null],
    'both blank' => [['from_date' => '', 'to_date' => " \t\n\u{00a0}"], null, null],
    'from only' => [['from_date' => '2040-04-30'], '2040-04-30', null],
    'to only' => [['to_date' => '1999-01-01'], null, '1999-01-01'],
    'blank from' => [['from_date' => ' ', 'to_date' => '1999-01-01'], null, '1999-01-01'],
    'blank to' => [['from_date' => '2040-04-30', 'to_date' => ' '], '2040-04-30', null],
    'inclusive leap day' => [['from_date' => '2000-02-29', 'to_date' => '2000-02-29'], '2000-02-29', '2000-02-29'],
    'explicit range' => [['from_date' => '1999-02-01', 'to_date' => '2000-12-31'], '1999-02-01', '2000-12-31'],
    'inverted stays inverted' => [['from_date' => '2026-01-01', 'to_date' => '2000-01-01'], '2026-01-01', '2000-01-01'],
];
foreach ($cases as $name => [$query, $from, $to]) {
    if (parseAllFormsSearchDates($query) !== ['from_date' => $from, 'to_date' => $to]) {
        throw new RuntimeException("Incorrect bounds: $name");
    }
    echo "PASS: $name\n";
}

foreach (['from_date', 'to_date'] as $key) {
    foreach ([[], ['2000-01-01'], null, false, 0, '0', 'yesterday', '2026-1-01', '01/01/2026',
              '1900-02-29', '2026-04-31', '2026-13-01', '0000-00-00', '2026-01-01T12:00:00',
              ' 2000-02-29 ', "2026-12-31\t", "\0", "2026-01-01\0"] as $value) {
        try {
            parseAllFormsSearchDates([$key => $value]);
        } catch (InvalidArgumentException $e) {
            if (!str_contains($e->getMessage(), $key)) throw new RuntimeException("Error must identify $key");
            continue;
        }
        throw new RuntimeException("Accepted invalid $key: " . json_encode($value));
    }
    echo "PASS: invalid $key values rejected\n";
}
