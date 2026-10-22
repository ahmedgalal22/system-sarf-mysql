<?php
/**
 * core/security.php — Security utilities
 */

/**
 * Sanitize a string for safe storage/comparison.
 * Trims whitespace, strips null bytes.
 */
function sanitizeString(?string $value): string {
    if ($value === null) return '';
    return trim(str_replace("\0", '', $value));
}

/**
 * Validate that a string is non-empty after sanitization.
 */
function requireNonEmpty(?string $value, string $fieldName): string {
    $clean = sanitizeString($value);
    if ($clean === '') {
        jsonError("{$fieldName} is required.", 400);
    }
    return $clean;
}

/**
 * Generate a UUID v4.
 */
function generateUUID(): string {
    $data = random_bytes(16);
    $data[6] = chr(ord($data[6]) & 0x0f | 0x40); // version 4
    $data[8] = chr(ord($data[8]) & 0x3f | 0x80); // variant RFC 4122
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}
