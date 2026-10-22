<?php
/**
 * core/response.php — Standardized JSON response helpers
 */

function jsonSuccess($data = null, string $message = 'OK', int $status = 200, ?array $meta = null): void {
    http_response_code($status);
    $payload = [
        'success' => true,
        'message' => $message,
        'data'    => $data,
    ];
    if ($meta !== null) {
        $payload['meta'] = $meta;
    }
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function jsonError(string $message, int $status = 400, array $errors = []): void {
    http_response_code($status);
    $payload = [
        'success' => false,
        'message' => $message,
    ];
    if (!empty($errors)) {
        $payload['errors'] = $errors;
    }
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function jsonMethodNotAllowed(string $allowed = 'POST'): void {
    header("Allow: {$allowed}");
    jsonError("Method not allowed. Use {$allowed}.", 405);
}
