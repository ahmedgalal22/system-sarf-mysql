<?php
/**
 * repositories/BolsaFormRepository.php — Bolsa Forms data access (Phase 6)
 */

class BolsaFormRepository {
    private PDO $db;
    public function __construct(PDO $db) { $this->db = $db; }

    public function getById(int $id): ?array {
        $stmt = $this->db->prepare('SELECT * FROM bolsa_forms WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch();
        if ($r) { $this->decodeJson($r); }
        return $r ?: null;
    }

    public function getByUuid(string $uuid): ?array {
        $stmt = $this->db->prepare('SELECT * FROM bolsa_forms WHERE uuid = :uuid AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':uuid' => $uuid]);
        $r = $stmt->fetch();
        if ($r) { $this->decodeJson($r); }
        return $r ?: null;
    }

    public function getAllByUsername(string $username): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM bolsa_forms WHERE username = :u AND deleted_at IS NULL AND is_archived = 0 ORDER BY created_at DESC'
        );
        $stmt->execute([':u' => $username]);
        $rows = $stmt->fetchAll();
        foreach ($rows as &$r) { $this->decodeJson($r); }
        return $rows;
    }

    public function create(array $data): array {
        $uuid = $data['uuid'] ?? $data['id'] ?? $this->uuid();
        $rows = isset($data['rows']) ? (is_string($data['rows']) ? $data['rows'] : json_encode($data['rows'])) : null;
        $totals = isset($data['totals']) ? (is_string($data['totals']) ? $data['totals'] : json_encode($data['totals'])) : null;

        $stmt = $this->db->prepare(
            'INSERT INTO bolsa_forms (uuid, username, agent_id, bolsa_date, `rows`, totals, amount,
                is_archived, archive_batch_id, created_by, created_at, updated_at)
             VALUES (:uuid, :username, :agent_id, :bolsa_date, :rows, :totals, :amount,
                :is_archived, :archive_batch_id, :created_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'            => $uuid,
            ':username'        => $data['username'],
            ':agent_id'        => $data['agent_id'] ?? null,
            ':bolsa_date'      => $data['bolsa_date'] ?? null,
            ':rows'            => $rows,
            ':totals'          => $totals,
            ':amount'          => intval($data['amount'] ?? 0),
            ':is_archived'     => intval($data['is_archived'] ?? 0),
            ':archive_batch_id'=> $data['archive_batch_id'] ?? null,
            ':created_by'      => $data['username'],
        ]);
        return $this->getById((int)$this->db->lastInsertId());
    }

    public function update(int $id, array $patch, string $username, ?string $expectedUpdatedAt = null): ?array {
        if ($expectedUpdatedAt !== null) {
            $cur = $this->getById($id);
            if ($cur && $cur['updated_at'] !== $expectedUpdatedAt) return null;
        }
        $allowed = ['agent_id','bolsa_date','rows','totals','amount'];
        $fields = []; $params = [':id' => $id, ':updated_by' => $username];
        foreach ($allowed as $f) {
            if (array_key_exists($f, $patch)) {
                $val = $patch[$f];
                if (($f === 'rows' || $f === 'totals') && !is_string($val)) $val = json_encode($val);
                $fields[] = "`{$f}` = :{$f}";
                $params[":{$f}"] = $val;
            }
        }
        if (empty($fields)) return $this->getById($id);
        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';
        $this->db->prepare('UPDATE bolsa_forms SET ' . implode(', ', $fields) . ' WHERE id = :id AND deleted_at IS NULL')->execute($params);
        return $this->getById($id);
    }

    public function softDelete(int $id, string $username): bool {
        $stmt = $this->db->prepare('UPDATE bolsa_forms SET deleted_at = NOW(3), deleted_by = :u WHERE id = :id AND deleted_at IS NULL');
        $stmt->execute([':id' => $id, ':u' => $username]);
        return $stmt->rowCount() > 0;
    }

    private function decodeJson(array &$row): void {
        if (is_string($row['rows'] ?? null)) $row['rows'] = json_decode($row['rows'], true) ?? [];
        if (is_string($row['totals'] ?? null)) $row['totals'] = json_decode($row['totals'], true) ?? [];
    }

    private function uuid(): string {
        $d = random_bytes(16); $d[6] = chr(ord($d[6]) & 0x0f | 0x40); $d[8] = chr(ord($d[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
