<?php
/**
 * core/json.php — JSON request body parser
 */

/**
 * Read and parse JSON from request body.
 * Returns associative array or null on failure.
 */
function readJsonBody(): ?array {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return null;
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return null;
    }
    return $decoded;
}

/**
 * Read JSON body or fail with 400 error.
 */
function requireJsonBody(): array {
    $body = readJsonBody();
    if ($body === null) {
        jsonError('Invalid or missing JSON body.', 400);
    }
    return $body;
}
