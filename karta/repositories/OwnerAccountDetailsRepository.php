<?php
/**
 * repositories/OwnerAccountDetailsRepository.php — Owner Account Details memo data access
 *
 * Dedicated repository for the non-financial "تفاصيل الحساب" tab inside
 * the Vehicle Owner Details page.
 * Strictly isolated from all financial ledgers, balances, and generic notes.
 */

class OwnerAccountDetailsRepository {
    private PDO $db;

    public function __construct(PDO $db) {
        $this->db = $db;
    }

    /**
     * Normalize Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits to ASCII (0-9).
     */
    public static function normalizeDigits(string $value): string {
        return strtr($value, [
            '٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4',
            '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9',
            '۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4',
            '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9',
            '٫' => '.',
        ]);
    }

    /**
     * Validate a memo numeric value (leh_amount or alayh_amount) without PHP float conversion.
     * Blank/null values return null.
     * Accepts non-negative integers and decimals with up to 2 decimal places.
     */
    public static function validateDecimalField($value, string $fieldLabel): ?string {
        if ($value === null) {
            return null;
        }
        if (is_bool($value) || is_array($value) || is_object($value)) {
            jsonError("حقل {$fieldLabel} يقبل أرقاماً فقط", 400);
        }

        $clean = trim(self::normalizeDigits((string) $value));
        if ($clean === '') {
            return null;
        }

        if (!preg_match('/^\d{1,12}(?:\.\d{1,2})?$/', $clean)) {
            jsonError("حقل {$fieldLabel} يقبل أرقاماً موجبة فقط (حتى خانتين عشريتين)", 400);
        }

        return $clean;
    }

    public function getById(int $id): ?array {
        $stmt = $this->db->prepare(
            'SELECT * FROM owner_account_details WHERE id = :id LIMIT 1'
        );
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function getByOwnerId(int $ownerId, string $username): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM owner_account_details
             WHERE owner_id = :owner_id AND username = :username
             ORDER BY id ASC'
        );
        $stmt->execute([
            ':owner_id' => $ownerId,
            ':username' => $username,
        ]);
        return $stmt->fetchAll();
    }

    public function getAllByUsername(string $username): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM owner_account_details
             WHERE username = :username
             ORDER BY owner_id ASC, id ASC'
        );
        $stmt->execute([':username' => $username]);
        return $stmt->fetchAll();
    }

    public function create(array $data): array {
        $stmt = $this->db->prepare(
            'INSERT INTO owner_account_details
                (uuid, owner_id, username, leh_amount, alayh_amount, notes,
                 entry_date, entry_time, created_by, updated_by, created_at, updated_at)
             VALUES
                (:uuid, :owner_id, :username, :leh_amount, :alayh_amount, :notes,
                 :entry_date, :entry_time, :created_by, :updated_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'         => $data['uuid'] ?? $this->generateUUID(),
            ':owner_id'     => (int) $data['owner_id'],
            ':username'     => $data['username'],
            ':leh_amount'   => $data['leh_amount'] ?? null,
            ':alayh_amount' => $data['alayh_amount'] ?? null,
            ':notes'        => $data['notes'] ?? null,
            ':entry_date'   => $data['entry_date'],
            ':entry_time'   => $data['entry_time'],
            ':created_by'   => $data['username'],
            ':updated_by'   => $data['username'],
        ]);
        return $this->getById((int) $this->db->lastInsertId());
    }

    /**
     * Update only leh_amount, alayh_amount, and notes.
     * Never modifies entry_date, entry_time, created_at, owner_id, or username.
     */
    public function update(int $id, array $patch, string $username): ?array {
        $allowed = ['leh_amount', 'alayh_amount', 'notes'];
        $fields = [];
        $params = [
            ':id'         => $id,
            ':username'   => $username,
            ':updated_by' => $username,
        ];

        foreach ($allowed as $field) {
            if (array_key_exists($field, $patch)) {
                $fields[] = "`{$field}` = :{$field}";
                $params[":{$field}"] = $patch[$field];
            }
        }

        if (empty($fields)) {
            return $this->getById($id);
        }

        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';

        $sql = 'UPDATE owner_account_details
                SET ' . implode(', ', $fields) . '
                WHERE id = :id AND username = :username';
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        return $this->getById($id);
    }

    private function generateUUID(): string {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
