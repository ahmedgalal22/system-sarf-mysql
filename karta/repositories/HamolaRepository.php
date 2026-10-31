<?php
/**
 * repositories/HamolaRepository.php — Hamola Details data access
 */

class HamolaRepository {
    private PDO $db;

    public function __construct(PDO $db) {
        $this->db = $db;
    }

    public function getById(int $id): ?array {
        $stmt = $this->db->prepare(
            'SELECT * FROM hamola_details WHERE id = :id AND deleted_at IS NULL LIMIT 1'
        );
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch();
        return $r ?: null;
    }

    public function getByOfficeId(int $officeId): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM hamola_details WHERE office_id = :oid AND deleted_at IS NULL ORDER BY created_at ASC'
        );
        $stmt->execute([':oid' => $officeId]);
        return $stmt->fetchAll();
    }

    public function getAllByUsername(string $username): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM hamola_details WHERE username = :u AND deleted_at IS NULL ORDER BY office_id, created_at ASC'
        );
        $stmt->execute([':u' => $username]);
        return $stmt->fetchAll();
    }

    public function normalizeCargoText(?string $value): string {
        if ($value === null) return '';
        $trimmed = trim((string) $value);
        if ($trimmed === '') return '';
        return preg_replace('/\s+/u', ' ', $trimmed) ?? $trimmed;
    }

    public function normalizeCargoKey(?string $value): string {
        $text = $this->normalizeCargoText($value);
        if ($text === '') return '';
        return function_exists('mb_strtolower')
            ? mb_strtolower($text, 'UTF-8')
            : strtolower($text);
    }

    public function findExistingCombination(
        int $officeId,
        string $username,
        string $loadingPlace,
        string $destinationPlace,
        ?string $itemType = null
    ): ?array {
        $loadKey = $this->normalizeCargoKey($loadingPlace);
        $destKey = $this->normalizeCargoKey($destinationPlace);
        $typeKey = $this->normalizeCargoKey($itemType);
        if ($loadKey === '' || $destKey === '') return null;

        $sql = 'SELECT * FROM hamola_details WHERE office_id = :oid AND username = :u AND deleted_at IS NULL ORDER BY created_at ASC';
        if ($this->db->inTransaction()) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':oid' => $officeId, ':u' => $username]);
        $rows = $stmt->fetchAll();

        foreach ($rows as $row) {
            $rLoad = $this->normalizeCargoKey($row['loading_place'] ?? '');
            $rDest = $this->normalizeCargoKey($row['destination_place'] ?? '');
            $rType = $this->normalizeCargoKey($row['item_type'] ?? '');
            if ($rLoad === $loadKey && $rDest === $destKey && $rType === $typeKey) {
                return $row;
            }
        }
        return null;
    }

    /**
     * Automatically register missing (loading_place, destination_place, item_type)
     * combinations from saved receipt rows into the selected office's hamola_details.
     *
     * Must be called inside the active receipt save/update DB transaction so a failed
     * receipt save never leaves cargo records behind.
     */
    public function syncFromReceiptRows(string $username, array $rows, OfficeRepository $officeRepo): array {
        if (empty($rows)) return [];

        $allOffices = $officeRepo->getAllByUsername($username);
        if (empty($allOffices)) return [];

        $officeIdByName = [];
        foreach ($allOffices as $o) {
            $normName = $this->normalizeCargoKey($o['name'] ?? '');
            if ($normName !== '') {
                $officeIdByName[$normName] = (int) $o['id'];
            }
        }
        if (empty($officeIdByName)) return [];

        $sql = 'SELECT * FROM hamola_details WHERE username = :u AND deleted_at IS NULL ORDER BY office_id, created_at ASC';
        if ($this->db->inTransaction()) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':u' => $username]);
        $allHamola = $stmt->fetchAll();

        $exactByOffice = [];
        $routeByOffice = [];
        foreach ($allHamola as $h) {
            $oid = (int) ($h['office_id'] ?? 0);
            if ($oid <= 0) continue;
            $lKey = $this->normalizeCargoKey($h['loading_place'] ?? '');
            $dKey = $this->normalizeCargoKey($h['destination_place'] ?? '');
            $tKey = $this->normalizeCargoKey($h['item_type'] ?? '');
            if ($lKey === '' || $dKey === '') continue;

            $routeKey = $lKey . '::' . $dKey;
            $exactKey = $routeKey . '::' . $tKey;
            $routeByOffice[$oid][$routeKey] = true;
            $exactByOffice[$oid][$exactKey] = true;
        }

        $created = [];
        foreach ($rows as $r) {
            if (!is_array($r)) continue;
            $rowType = $r['_type'] ?? $r['row_type'] ?? 'data';
            if ($rowType === 'separator') continue;

            $officeName  = $this->normalizeCargoText($r['office'] ?? '');
            $loading     = $this->normalizeCargoText($r['loading'] ?? $r['loading_place'] ?? '');
            $destination = $this->normalizeCargoText($r['taktik'] ?? $r['destination_place'] ?? $r['direction'] ?? '');
            $itemType    = $this->normalizeCargoText($r['type'] ?? $r['item_type'] ?? '');

            if ($officeName === '' || $loading === '' || $destination === '') {
                continue;
            }

            $officeKey = $this->normalizeCargoKey($officeName);
            $officeId = $officeIdByName[$officeKey] ?? null;
            if (!$officeId) {
                continue;
            }

            $loadKey  = $this->normalizeCargoKey($loading);
            $destKey  = $this->normalizeCargoKey($destination);
            $typeKey  = $this->normalizeCargoKey($itemType);
            $routeKey = $loadKey . '::' . $destKey;
            $exactKey = $routeKey . '::' . $typeKey;

            if (!empty($exactByOffice[$officeId][$exactKey])) {
                continue;
            }
            if ($typeKey === '' && !empty($routeByOffice[$officeId][$routeKey])) {
                continue;
            }

            $record = $this->create([
                'uuid'              => null,
                'office_id'         => $officeId,
                'username'          => $username,
                'loading_place'     => $loading,
                'destination_place' => $destination,
                'nolon'             => 0,
                'office_amount'     => 0,
                'item_type'         => $itemType !== '' ? $itemType : null,
                'price'             => 0,
            ]);

            $exactByOffice[$officeId][$exactKey] = true;
            $routeByOffice[$officeId][$routeKey] = true;
            $created[] = $record;
        }

        return $created;
    }

    public function create(array $data): array {
        $stmt = $this->db->prepare(
            'INSERT INTO hamola_details (uuid, office_id, username, loading_place, destination_place, nolon, office_amount, item_type, price, created_by, created_at, updated_at)
             VALUES (:uuid, :office_id, :username, :loading_place, :destination_place, :nolon, :office_amount, :item_type, :price, :created_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'              => $data['uuid'] ?? $this->generateUUID(),
            ':office_id'         => $data['office_id'],
            ':username'          => $data['username'],
            ':loading_place'     => $data['loading_place'],
            ':destination_place' => $data['destination_place'],
            ':nolon'             => $data['nolon'] ?? 0,
            ':office_amount'     => $data['office_amount'] ?? 0,
            ':item_type'         => $data['item_type'] ?? null,
            ':price'             => $data['price'] ?? 0,
            ':created_by'        => $data['username'],
        ]);
        return $this->getById((int) $this->db->lastInsertId());
    }

    public function update(int $id, array $patch, string $username): ?array {
        $allowed = ['loading_place', 'destination_place', 'nolon', 'office_amount', 'item_type', 'price'];
        $fields = [];
        $params = [':id' => $id, ':updated_by' => $username];

        foreach ($allowed as $f) {
            if (array_key_exists($f, $patch)) {
                $fields[] = "`{$f}` = :{$f}";
                $params[":{$f}"] = $patch[$f];
            }
        }

        if (empty($fields)) return $this->getById($id);

        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';
        $sql = 'UPDATE hamola_details SET ' . implode(', ', $fields) . ' WHERE id = :id AND deleted_at IS NULL';
        $this->db->prepare($sql)->execute($params);
        return $this->getById($id);
    }

    public function softDelete(int $id, string $username): bool {
        $stmt = $this->db->prepare(
            'UPDATE hamola_details SET deleted_at = NOW(3), deleted_by = :u, updated_by = :u WHERE id = :id AND deleted_at IS NULL'
        );
        $stmt->execute([':id' => $id, ':u' => $username]);
        return $stmt->rowCount() > 0;
    }

    private function generateUUID(): string {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
