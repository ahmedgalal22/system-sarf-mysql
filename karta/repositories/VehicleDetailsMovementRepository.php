<?php
/**
 * repositories/VehicleDetailsMovementRepository.php — Vehicle Details Movements data access
 *
 * Dedicated repository for the standalone "تفاصيل السيارات" feature.
 * All operations target ONLY the `vehicle_details_movements` table
 * (with read-only eligibility checks against `vehicle_owners`).
 * Zero interaction with financial tables (`vehicle_ledger`, `treasury`, `receipts`, `offices`).
 */

class VehicleDetailsMovementRepository {
    private PDO $db;

    public function __construct(PDO $db) {
        $this->db = $db;
    }

    /**
     * Validate that the requested owner exists, is active, is not a broker,
     * and belongs to the authenticated user's scope. Read-only check.
     */
    public function validateEligibleOwner(int $ownerId, string $username): array {
        if ($ownerId <= 0) {
            return ['ok' => false, 'status' => 400, 'message' => 'معرّف صاحب المركبة مطلوب'];
        }

        $stmt = $this->db->prepare(
            'SELECT id, username, name, owner_type, deleted_at FROM vehicle_owners WHERE id = :id LIMIT 1'
        );
        $stmt->execute([':id' => $ownerId]);
        $owner = $stmt->fetch();

        if (!$owner || $owner['deleted_at'] !== null) {
            return ['ok' => false, 'status' => 404, 'message' => 'صاحب المركبة غير موجود'];
        }

        if (($owner['username'] ?? '') !== $username) {
            return ['ok' => false, 'status' => 403, 'message' => 'غير مسموح'];
        }

        if (($owner['owner_type'] ?? 'owner') === 'broker') {
            return ['ok' => false, 'status' => 400, 'message' => 'لا يمكن تسجيل تفاصيل سيارات لوسيط'];
        }

        return [
            'ok'    => true,
            'owner' => [
                'id'   => (int) $owner['id'],
                'name' => (string) $owner['name'],
            ],
        ];
    }

    public function getById(int $id): ?array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_details_movements WHERE id = :id AND deleted_at IS NULL LIMIT 1'
        );
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch();
        return $r ? $this->normalizeRow($r) : null;
    }

    public function getByUuid(string $uuid): ?array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_details_movements WHERE uuid = :uuid AND deleted_at IS NULL LIMIT 1'
        );
        $stmt->execute([':uuid' => $uuid]);
        $r = $stmt->fetch();
        return $r ? $this->normalizeRow($r) : null;
    }

    public function getByOwnerId(int $ownerId, string $username, array $filters = []): array {
        $sql = 'SELECT * FROM vehicle_details_movements
                WHERE owner_id = :oid AND username = :u AND deleted_at IS NULL';
        $params = [
            ':oid' => $ownerId,
            ':u'   => $username,
        ];

        if (!empty($filters['from_date'])) {
            $sql .= ' AND movement_date >= :from_date';
            $params[':from_date'] = $filters['from_date'];
        }
        if (!empty($filters['to_date'])) {
            $sql .= ' AND movement_date <= :to_date';
            $params[':to_date'] = $filters['to_date'];
        }

        $sql .= ' ORDER BY movement_date DESC, movement_time DESC, id DESC';
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();
        return array_map([$this, 'normalizeRow'], $rows);
    }

    public function getAllByUsername(string $username, array $filters = []): array {
        $sql = 'SELECT m.* FROM vehicle_details_movements m
                INNER JOIN vehicle_owners o ON o.id = m.owner_id
                WHERE m.username = :u
                  AND m.deleted_at IS NULL
                  AND o.username = :u_owner
                  AND o.deleted_at IS NULL
                  AND o.owner_type != :broker_type';
        $params = [
            ':u'           => $username,
            ':u_owner'     => $username,
            ':broker_type' => 'broker',
        ];

        if (!empty($filters['owner_id'])) {
            $sql .= ' AND m.owner_id = :oid';
            $params[':oid'] = (int) $filters['owner_id'];
        }
        if (!empty($filters['from_date'])) {
            $sql .= ' AND m.movement_date >= :from_date';
            $params[':from_date'] = $filters['from_date'];
        }
        if (!empty($filters['to_date'])) {
            $sql .= ' AND m.movement_date <= :to_date';
            $params[':to_date'] = $filters['to_date'];
        }

        $sql .= ' ORDER BY m.movement_date DESC, m.movement_time DESC, m.id DESC';
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();
        return array_map([$this, 'normalizeRow'], $rows);
    }

    public function create(array $data): array {
        $stmt = $this->db->prepare(
            'INSERT INTO vehicle_details_movements
             (uuid, owner_id, username, movement_date, movement_time, lah, alayh, notes, created_by, created_at, updated_at)
             VALUES (:uuid, :owner_id, :username, :movement_date, :movement_time, :lah, :alayh, :notes, :created_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'          => $data['uuid'] ?? $this->generateUUID(),
            ':owner_id'      => (int) $data['owner_id'],
            ':username'      => $data['username'],
            ':movement_date' => $data['movement_date'],
            ':movement_time' => $data['movement_time'],
            ':lah'           => number_format((float) ($data['lah'] ?? 0), 2, '.', ''),
            ':alayh'         => number_format((float) ($data['alayh'] ?? 0), 2, '.', ''),
            ':notes'         => $data['notes'] ?? null,
            ':created_by'    => $data['username'],
        ]);
        return $this->getById((int) $this->db->lastInsertId());
    }

    /**
     * Update only manual fields (lah, alayh, notes).
     * Never modifies movement_date, movement_time, owner_id, or username.
     */
    public function update(int $id, array $patch, string $username): ?array {
        $allowed = ['lah', 'alayh', 'notes'];
        $fields = [];
        $params = [
            ':id'         => $id,
            ':username'   => $username,
            ':updated_by' => $username,
        ];

        foreach ($allowed as $f) {
            if (array_key_exists($f, $patch)) {
                $fields[] = "`{$f}` = :{$f}";
                if ($f === 'lah' || $f === 'alayh') {
                    $params[":{$f}"] = number_format((float) $patch[$f], 2, '.', '');
                } else {
                    $params[":{$f}"] = $patch[$f];
                }
            }
        }

        if (empty($fields)) {
            return $this->getById($id);
        }

        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';
        $sql = 'UPDATE vehicle_details_movements SET ' . implode(', ', $fields)
             . ' WHERE id = :id AND username = :username AND deleted_at IS NULL';
        $this->db->prepare($sql)->execute($params);
        return $this->getById($id);
    }

    public function softDelete(int $id, string $username): bool {
        $stmt = $this->db->prepare(
            'UPDATE vehicle_details_movements
             SET deleted_at = NOW(3), deleted_by = :u, updated_by = :u, updated_at = NOW(3)
             WHERE id = :id AND username = :u AND deleted_at IS NULL'
        );
        $stmt->execute([':id' => $id, ':u' => $username]);
        return $stmt->rowCount() > 0;
    }

    public function validateIsoDate(?string $date): ?string {
        if ($date === null) return null;
        $trimmed = trim($date);
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $trimmed, $m)) {
            return null;
        }
        $year  = (int) $m[1];
        $month = (int) $m[2];
        $day   = (int) $m[3];
        if (!checkdate($month, $day, $year)) {
            return null;
        }
        return sprintf('%04d-%02d-%02d', $year, $month, $day);
    }

    public function validateTime(?string $time): ?string {
        if ($time === null) return null;
        $trimmed = trim($time);
        if (!preg_match('/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/', $trimmed, $m)) {
            return null;
        }
        $hour = (int) $m[1];
        $min  = (int) $m[2];
        $sec  = isset($m[3]) && $m[3] !== '' ? (int) $m[3] : 0;
        return sprintf('%02d:%02d:%02d', $hour, $min, $sec);
    }

    public function validateAmount($value): ?float {
        if ($value === null || $value === '') {
            return 0.0;
        }
        if (is_bool($value) || is_array($value) || is_object($value)) {
            return null;
        }
        if (is_string($value)) {
            $value = trim($value);
            if ($value === '') return 0.0;
        }
        if (!is_numeric($value)) {
            return null;
        }
        $num = (float) $value;
        if (!is_finite($num) || $num < 0) {
            return null;
        }
        return round($num, 2);
    }

    private function normalizeRow(array $row): array {
        $row['id']       = (int) $row['id'];
        $row['owner_id'] = (int) $row['owner_id'];
        $row['lah']      = round((float) ($row['lah'] ?? 0), 2);
        $row['alayh']    = round((float) ($row['alayh'] ?? 0), 2);
        return $row;
    }

    private function generateUUID(): string {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
