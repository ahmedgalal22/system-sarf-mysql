<?php
/**
 * GET /api/stats/office-summary.php
 *
 * Returns per-office weight and net totals computed server-side.
 * Replaces the pattern: load ALL receipts → loop per office.
 *
 * FORMULA (mirrors financialCalculator.js exactly):
 *   weight = (weight + weight2) - deficit
 *   net    = ((weight + weight2) - deficit) * noloon
 *            - (ohda + officeAmount + sarf)
 *            + add
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $db = getDB();

    $stmt = $db->prepare(
        "SELECT id, `rows`
         FROM receipts
         WHERE username = :u
           AND deleted_at IS NULL
           AND is_archived = 0"
    );
    $stmt->execute([':u' => $authUser['username']]);
    $receipts = $stmt->fetchAll();

    $summary = [];
    foreach ($receipts as $r) {
        $rows = json_decode($r['rows'] ?? '[]', true) ?: [];
        foreach ($rows as $row) {
            $type = $row['_type'] ?? ($row['type'] ?? ($row['row_type'] ?? ''));
            if ($type === 'separator') continue;
            $officeName = trim($row['office'] ?? '');
            if ($officeName === '') continue;

            $key = mb_strtolower($officeName);
            if (!isset($summary[$key])) {
                $summary[$key] = ['name' => $officeName, 'weight' => 0, 'net' => 0];
            }

            // Exact mirror of financialCalculator.js calculateWeightTotal
            $w1      = floatval($row['weight'] ?? 0);
            $w2      = floatval($row['weight2'] ?? 0);
            $deficit = floatval($row['deficit'] ?? 0);
            $weightTotal = ($w1 + $w2) - $deficit;

            // Exact mirror of financialCalculator.js calculateRowNet
            $noloon       = floatval($row['noloon'] ?? 0);
            $ohda         = floatval($row['ohda'] ?? 0);
            $officeAmount = floatval($row['officeAmount'] ?? ($row['office_amount'] ?? 0));
            $sarf         = floatval($row['sarf'] ?? 0);
            $add          = floatval($row['add'] ?? 0);

            $net = ($weightTotal * $noloon)
                 - ($ohda + $officeAmount + $sarf)
                 + $add;

            $summary[$key]['weight'] += $weightTotal;
            $summary[$key]['net']    += round($net, 2);
        }
    }

    jsonSuccess(array_values($summary));

} catch (PDOException $e) {
    error_log('[STATS OFFICE SUMMARY] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
