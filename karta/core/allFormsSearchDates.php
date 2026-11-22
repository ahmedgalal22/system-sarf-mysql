<?php
/** Parse only the All Forms search boundaries; no clock, database or response handling. */
function parseAllFormsSearchDates(array $query): array {
    $dates = ['from_date' => null, 'to_date' => null];
    foreach (array_keys($dates) as $key) {
        if (!array_key_exists($key, $query)) continue;
        $date = $query[$key];
        if (!is_string($date)) {
            throw new InvalidArgumentException("{$key} يجب أن يكون نصًا بصيغة YYYY-MM-DD");
        }
        if (preg_match('/\A\s*\z/u', $date)) continue;
        if (!preg_match('/\A([0-9]{4})-([0-9]{2})-([0-9]{2})\z/', $date, $parts)
            || !checkdate((int)$parts[2], (int)$parts[3], (int)$parts[1])) {
            throw new InvalidArgumentException("{$key} تاريخ غير صالح (YYYY-MM-DD)");
        }
        $dates[$key] = $date;
    }
    return $dates;
}
