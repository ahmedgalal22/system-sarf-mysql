<?php
/**
 * GET /api/stats/office-summary.php
 *
 * Returns per-office weight and net totals computed server-side.
 * Replaces the pattern: load ALL receipts → loop per office.
 *
 * FORMULA (mirrors financialCalculator.js exactly):
 *   weight = weight - (deficit / 1000)
 *   net    = (weight - (deficit / 1000)) * noloon
 *            - (ohda + officeAmount + sarf)
 *            + add
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $db = getDB();

    $fromDate = sanitizeString($_GET['from'] ?? ($_GET['from_date'] ?? null));
    $toDate   = sanitizeString($_GET['to'] ?? ($_GET['to_date'] ?? null));
    $isValidIsoDate = static function (string $d): bool {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) return false;
        [$y, $m, $day] = array_map('intval', explode('-', $d));
        return checkdate($m, $day, $y);
    };
    if ($fromDate !== '' && !$isValidIsoDate($fromDate)) {
        jsonError('تنسيق تاريخ البداية غير صالح (YYYY-MM-DD)', 400);
    }
    if ($toDate !== '' && !$isValidIsoDate($toDate)) {
        jsonError('تنسيق تاريخ النهاية غير صالح (YYYY-MM-DD)', 400);
    }
    if ($fromDate !== '' && $toDate !== '' && $toDate < $fromDate) {
        jsonError('تاريخ النهاية لا يمكن أن يكون أقدم من تاريخ البداية', 400);
    }

    $sql = "SELECT id, `rows`
            FROM receipts
            WHERE username = :u
              AND deleted_at IS NULL
              AND is_archived = 0";
    $params = [':u' => $authUser['username']];
    if ($fromDate !== '') {
        $sql .= ' AND receipt_date >= :from_date';
        $params[':from_date'] = $fromDate;
    }
    if ($toDate !== '') {
        $sql .= ' AND receipt_date <= :to_date';
        $params[':to_date'] = $toDate;
    }

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
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

            // Exact mirror of financialCalculator.js calculateWeightTotal (weight in tons, deficit in kg)
            $w1      = floatval($row['weight'] ?? 0);
            $deficit = floatval($row['deficit'] ?? 0) / 1000.0;
            $weightTotal = $w1 - $deficit;

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
