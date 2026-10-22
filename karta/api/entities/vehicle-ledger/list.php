<?php
/**
 * GET /api/entities/vehicle-ledger/list.php
 *
 * Supports filters via query params:
 *   vehicle_id, client_id, reference_id,
 *   client_type, is_reversed, reference_type
 *   All filters are optional. Without filters → returns all for user.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleLedgerRepository.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $db = getDB();
    $username = $authUser['username'];

    // Build filtered query dynamically
    $sql = 'SELECT * FROM vehicle_ledger WHERE username = :u AND deleted_at IS NULL';
    $params = [':u' => $username];

    // vehicle_id filter
    $vehicleId = sanitizeString($_GET['vehicle_id'] ?? null);
    if ($vehicleId !== '') {
        $sql .= ' AND vehicle_id = :vehicle_id';
        $params[':vehicle_id'] = $vehicleId;
    }

    // client_id filter (canonical financial identity)
    $clientId = sanitizeString($_GET['client_id'] ?? null);
    if ($clientId !== '') {
        $sql .= ' AND client_id = :client_id';
        $params[':client_id'] = $clientId;
    }

    // reference_id filter
    $refId = sanitizeString($_GET['reference_id'] ?? null);
    if ($refId !== '') {
        $sql .= ' AND reference_id = :reference_id';
        $params[':reference_id'] = $refId;
    }

    // client_type filter (owner / office / mandoub)
    $clientType = sanitizeString($_GET['client_type'] ?? null);
    if ($clientType !== '') {
        $sql .= ' AND client_type = :client_type';
        $params[':client_type'] = $clientType;
    }


    // reference_type filter
    $refType = sanitizeString($_GET['reference_type'] ?? null);
    if ($refType !== '') {
        $sql .= ' AND reference_type = :reference_type';
        $params[':reference_type'] = $refType;
    }

    // is_reversed filter
    $isReversed = $_GET['is_reversed'] ?? null;
    if ($isReversed !== null && $isReversed !== '') {
        $reversed = ($isReversed === 'true' || $isReversed === '1') ? 1 : 0;
        $sql .= ' AND is_reversed = :is_reversed';
        $params[':is_reversed'] = $reversed;
    }

    // include_archived flag
    if (!isset($_GET['include_archived']) || $_GET['include_archived'] !== '1') {
        $sql .= ' AND is_archived = 0';
    }

    $sql .= ' ORDER BY date DESC, created_at DESC';

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    jsonSuccess($stmt->fetchAll());

} catch (PDOException $e) {
    error_log('[LEDGER LIST] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
