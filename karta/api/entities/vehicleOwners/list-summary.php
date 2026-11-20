<?php
/** GET: vehicle owners screen only. No posted identities, financial writes or persistent cache. */
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleOwnerListRepository.php';
header('Cache-Control: private, no-store');
if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $db = getDB();
    // This endpoint's request-local connection: do not buffer every owner's history in PDO.
    $buffered = defined('Pdo\\Mysql::ATTR_USE_BUFFERED_QUERY')
        ? Pdo\Mysql::ATTR_USE_BUFFERED_QUERY : PDO::MYSQL_ATTR_USE_BUFFERED_QUERY;
    $db->setAttribute($buffered, false);
    $db->exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    $db->beginTransaction();
    $rows = (new VehicleOwnerListRepository($db))->getForUser($authUser['username']);
    $db->commit();
    jsonSuccess($rows);
} catch (Throwable $e) {
    if (isset($db) && $db->inTransaction()) $db->rollBack();
    error_log('[OWNER LIST SUMMARY] ' . $e->getMessage());
    jsonError('تعذر تحميل أرصدة أصحاب المركبات', 500);
}
