<?php
/**
 * repositories/VehicleLedgerRepository.php — Vehicle Ledger data access
 *
 * Financial identity: client_id + client_type (canonical, single source of truth).
 * Asset ownership: vehicle_owner_id + vehicle_owner_name (separate concept).
 */

class VehicleLedgerRepository {
    private PDO $db;
    public function __construct(PDO $db) { $this->db = $db; }

    public function getById(int $id): ?array {
        $stmt = $this->db->prepare('SELECT * FROM vehicle_ledger WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch(); return $r ?: null;
    }

    public function getAllByUsername(string $username): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_ledger WHERE username = :u AND deleted_at IS NULL AND is_archived = 0 ORDER BY created_at DESC'
        );
        $stmt->execute([':u' => $username]);
        return $stmt->fetchAll();
    }

    public function getByVehicle(string $vehicleId): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_ledger WHERE vehicle_id = :vid AND deleted_at IS NULL ORDER BY created_at DESC'
        );
        $stmt->execute([':vid' => $vehicleId]);
        return $stmt->fetchAll();
    }

    public function getByClient(string $clientId, string $clientType): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_ledger WHERE client_id = :cid AND client_type = :ct AND deleted_at IS NULL AND is_reversed = 0 ORDER BY date DESC, created_at DESC'
        );
        $stmt->execute([':cid' => $clientId, ':ct' => $clientType]);
        return $stmt->fetchAll();
    }

    public function getByReference(string $referenceId): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_ledger WHERE reference_id = :rid AND deleted_at IS NULL ORDER BY created_at DESC'
        );
        $stmt->execute([':rid' => $referenceId]);
        return $stmt->fetchAll();
    }

    public function getActiveByReference(string $referenceId, string $referenceType): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_ledger WHERE reference_id = :rid AND reference_type = :rt AND is_reversed = 0 AND deleted_at IS NULL'
        );
        $stmt->execute([':rid' => $referenceId, ':rt' => $referenceType]);
        return $stmt->fetchAll();
    }

    public function create(array $data): array {
        $uuid = $data['uuid'] ?? $this->uuid();
        $stmt = $this->db->prepare(
            'INSERT INTO vehicle_ledger (uuid, username, vehicle_id, vehicle_plate, vehicle_owner_id, vehicle_owner_name,
                client_id, client_type, client_name,
                type, effect, amount, reference_type, reference_id, receipt_number,
                date, applied_at, note, is_reversed, is_archived, archive_batch_id,
                created_by, created_at, updated_at)
             VALUES (:uuid, :username, :vehicle_id, :vehicle_plate, :vehicle_owner_id, :vehicle_owner_name,
                :client_id, :client_type, :client_name,
                :type, :effect, :amount, :reference_type, :reference_id, :receipt_number,
                :date, :applied_at, :note, :is_reversed, :is_archived, :archive_batch_id,
                :created_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'              => $uuid,
            ':username'          => $data['username'],
            ':vehicle_id'        => $data['vehicle_id'] ?? null,
            ':vehicle_plate'     => $data['vehicle_plate'] ?? null,
            ':vehicle_owner_id'  => $data['vehicle_owner_id'] ?? null,
            ':vehicle_owner_name'=> $data['vehicle_owner_name'] ?? null,
            ':client_id'         => $data['client_id'] ?? null,
            ':client_type'       => $data['client_type'] ?? null,
            ':client_name'       => $data['client_name'] ?? null,
            ':type'              => $data['type'] ?? 'deposit',
            ':effect'            => $data['effect'] ?? null,
            ':amount'            => intval($data['amount'] ?? 0),
            ':reference_type'    => $data['reference_type'] ?? null,
            ':reference_id'      => $data['reference_id'] ?? null,
            ':receipt_number'    => $data['receipt_number'] ?? null,
            ':date'              => $data['date'] ?? null,
            ':applied_at'        => $data['applied_at'] ?? null,
            ':note'              => $data['note'] ?? null,
            ':is_reversed'       => intval($data['is_reversed'] ?? 0),
            ':is_archived'       => intval($data['is_archived'] ?? 0),
            ':archive_batch_id'  => $data['archive_batch_id'] ?? null,
            ':created_by'        => $data['username'],
        ]);
        return $this->getById((int)$this->db->lastInsertId());
    }

    public function update(int $id, array $patch, string $username, ?string $expectedUpdatedAt = null): ?array {
        if ($expectedUpdatedAt !== null) {
            $cur = $this->getById($id);
            if ($cur && $cur['updated_at'] !== $expectedUpdatedAt) return null;
        }
        $allowed = ['type','effect','amount','date','note','is_reversed','reversed_at','reversed_by',
                     'client_id','client_type','client_name'];
        $fields = []; $params = [':id' => $id, ':updated_by' => $username];
        foreach ($allowed as $f) {
            if (array_key_exists($f, $patch)) { $fields[] = "`{$f}` = :{$f}"; $params[":{$f}"] = $patch[$f]; }
        }
        if (empty($fields)) return $this->getById($id);
        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';
        $this->db->prepare('UPDATE vehicle_ledger SET ' . implode(', ', $fields) . ' WHERE id = :id AND deleted_at IS NULL')->execute($params);
        return $this->getById($id);
    }

    public function reverseByReference(string $referenceId, string $referenceType, string $username): int {
        $now = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s.v');
        $stmt = $this->db->prepare(
            'UPDATE vehicle_ledger SET is_reversed = 1, reversed_at = :now, reversed_by = :u, updated_at = NOW(3)
             WHERE reference_id = :rid AND reference_type = :rt AND is_reversed = 0 AND deleted_at IS NULL'
        );
        $stmt->execute([':rid' => $referenceId, ':rt' => $referenceType, ':u' => $username, ':now' => $now]);
        return $stmt->rowCount();
    }

    public function softDelete(int $id, string $username): bool {
        $stmt = $this->db->prepare('UPDATE vehicle_ledger SET deleted_at = NOW(3), deleted_by = :u WHERE id = :id AND deleted_at IS NULL');
        $stmt->execute([':id' => $id, ':u' => $username]);
        return $stmt->rowCount() > 0;
    }

    private function uuid(): string {
        $d = random_bytes(16); $d[6] = chr(ord($d[6]) & 0x0f | 0x40); $d[8] = chr(ord($d[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
