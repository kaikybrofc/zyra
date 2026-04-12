-- Auditoria de Integridade Estrutural Profunda

-- 1. Divergência de Tamanho de Grupo
-- Verifica se o campo 'size' no metadado do grupo coincide com os participantes salvos.
SELECT 
    g.jid, 
    g.subject, 
    g.size as expected_size, 
    COUNT(gp.user_id) as actual_participants,
    ABS(g.size - COUNT(gp.user_id)) as discrepancy
FROM zyra.`groups` g
LEFT JOIN zyra.group_participants gp ON g.jid = gp.group_jid
GROUP BY g.jid, g.subject, g.size
HAVING discrepancy > 0;

-- 2. Consistência de Mensagens Enviadas (fromMe consistency)
-- Garante que mensagens marcadas como enviadas pelo bot estão corretamente vinculadas.
SELECT 
    m.id as msg_db_id, 
    m.message_id, 
    u.display_name as sender_name
FROM zyra.messages m
LEFT JOIN zyra.users u ON m.sender_user_id = u.id
WHERE m.from_me = 1 AND m.sender_user_id IS NULL;

-- 3. Análise de Latência de Persistência (Drift Temporal)
-- Mede a diferença média em segundos entre a mensagem ser enviada e ser salva no banco.
SELECT 
    AVG(ABS(UNIX_TIMESTAMP(updated_at) - timestamp)) as avg_latency_seconds,
    MAX(ABS(UNIX_TIMESTAMP(updated_at) - timestamp)) as max_latency_seconds
FROM zyra.messages 
WHERE timestamp > 0;

-- 4. Detecção de Usuários "Incompletos"
-- Usuários que existem mas não possuem JID, PN ou LID vinculados.
SELECT u.id, u.display_name
FROM zyra.users u
LEFT JOIN zyra.user_identifiers ui ON u.id = ui.user_id
WHERE ui.user_id IS NULL;

-- 5. Integridade de Mídia (Metadados vs JSON)
-- Verifica se as mídias registradas possuem os campos essenciais.
SELECT 
    m.message_id, 
    mm.media_type, 
    mm.mime_type
FROM zyra.message_media mm
JOIN zyra.messages m ON mm.message_db_id = m.id
WHERE mm.mime_type IS NULL OR mm.media_type IS NULL;
