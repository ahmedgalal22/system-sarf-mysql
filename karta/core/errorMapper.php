<?php
/**
 * core/errorMapper.php — Result Code → HTTP Response mapper
 *
 * Single responsibility: convert domain Result Codes to HTTP JSON responses.
 * NO business logic. NO SQL. NO validation.
 *
 * Usage:
 *   mapResult('CONFLICT', $latestData);
 *   mapResult('ARCHIVED');
 *   mapResult('NOT_FOUND');
 */

/**
 * Map a domain Result Code to an HTTP JSON response and exit.
 *
 * @param string     $code    — OK, NOT_FOUND, CONFLICT, ARCHIVED, DUPLICATE
 * @param mixed      $data    — response payload (record for OK, latest for CONFLICT)
 * @param string     $message — optional override message
 */
function mapResult(string $code, $data = null, string $message = ''): void {
    switch ($code) {
        case 'OK':
            jsonSuccess($data, $message ?: 'تمت العملية بنجاح');
            break;

        case 'CREATED':
            jsonSuccess($data, $message ?: 'تم الإنشاء بنجاح', 201);
            break;

        case 'DUPLICATE':
            jsonSuccess($data, $message ?: 'السجل موجود مسبقاً (idempotent)', 200);
            break;

        case 'NOT_FOUND':
            jsonError($message ?: 'السجل غير موجود', 404);
            break;

        case 'CONFLICT':
            http_response_code(409);
            echo json_encode([
                'success'  => false,
                'type'     => 'conflict',
                'message'  => $message ?: 'تعارض — تم تعديل السجل من مستخدم آخر',
                'conflict' => true,
                'latest'   => $data,
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            exit;

        case 'ARCHIVED':
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'type'    => 'archived',
                'message' => $message ?: 'لا يمكن تعديل أو حذف سجل مؤرشف',
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            exit;

        case 'FORBIDDEN':
            jsonError($message ?: 'غير مسموح', 403);
            break;

        default:
            jsonError($message ?: 'خطأ غير متوقع', 500);
            break;
    }
}

/**
 * Decode JSON rows field if present and stringified, and normalize row IDs & statuses.
 */
function decodeRowsField(?array &$record): void {
    if (!$record) return;
    if (is_string($record['rows'] ?? null)) {
        $record['rows'] = json_decode($record['rows'], true) ?? [];
    }
    if (is_array($record['rows'] ?? null) && class_exists('ReceiptRepository')) {
        $record['rows'] = ReceiptRepository::normalizeReceiptRows($record['rows'], $record['id'] ?? '');
    }
}
