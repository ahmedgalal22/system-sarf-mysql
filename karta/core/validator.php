<?php
/**
 * core/validator.php — Central input validation (NO business logic)
 *
 * Only validates: types, formats, required fields, enums, null safety.
 * Does NOT validate financial rules, balance checks, or business constraints.
 */

/**
 * Validate that a value is a non-empty string.
 */
function validateRequired($value, string $fieldName): string {
    $clean = sanitizeString($value);
    if ($clean === '') {
        jsonError("{$fieldName} مطلوب", 400);
    }
    return $clean;
}

/**
 * Validate that a value is a positive integer.
 */
function validatePositiveInt($value, string $fieldName): int {
    $int = intval($value);
    if ($int <= 0) {
        jsonError("{$fieldName} يجب أن يكون رقم صحيح موجب", 400);
    }
    return $int;
}

/**
 * Validate UUID format (v4).
 */
function validateUUID(?string $value, string $fieldName, bool $required = true): ?string {
    $clean = sanitizeString($value);
    if ($clean === '') {
        if ($required) jsonError("{$fieldName} مطلوب", 400);
        return null;
    }
    if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $clean)) {
        jsonError("{$fieldName} تنسيق UUID غير صالح", 400);
    }
    return $clean;
}

/**
 * Validate that a value is one of allowed options.
 */
function validateEnum($value, array $allowed, string $fieldName): string {
    $clean = sanitizeString($value);
    if (!in_array($clean, $allowed, true)) {
        $opts = implode(', ', $allowed);
        jsonError("{$fieldName} يجب أن يكون أحد: {$opts}", 400);
    }
    return $clean;
}

/**
 * Validate ISO date format (YYYY-MM-DD).
 */
function validateDate(?string $value, string $fieldName, bool $required = true): ?string {
    $clean = sanitizeString($value);
    if ($clean === '') {
        if ($required) jsonError("{$fieldName} مطلوب", 400);
        return null;
    }
    $d = DateTime::createFromFormat('Y-m-d', $clean);
    if (!$d || $d->format('Y-m-d') !== $clean) {
        jsonError("{$fieldName} تنسيق تاريخ غير صالح (YYYY-MM-DD)", 400);
    }
    return $clean;
}

/**
 * Validate that a numeric value is non-negative.
 */
function validateNonNegative($value, string $fieldName): float {
    $num = floatval($value);
    if ($num < 0) {
        jsonError("{$fieldName} لا يمكن أن يكون سالباً", 400);
    }
    return $num;
}

/**
 * Validate array/object is not empty.
 */
function validateNonEmptyArray($value, string $fieldName): array {
    if (!is_array($value) || empty($value)) {
        jsonError("{$fieldName} يجب أن يحتوي على عنصر واحد على الأقل", 400);
    }
    return $value;
}
