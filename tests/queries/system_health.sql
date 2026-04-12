-- Diagnóstico de Saúde do Banco e Órfãos
-- Verifica se existem dados sem pai (referências quebradas).

SELECT 'Mensagens sem Chat' as issue, COUNT(*) as count
FROM messages m 
LEFT JOIN chats c ON m.chat_jid = c.jid AND m.connection_id = c.connection_id 
WHERE c.jid IS NULL
UNION ALL
SELECT 'Participantes sem Grupo' as issue, COUNT(*) as count
FROM group_participants gp
LEFT JOIN `groups` g ON gp.group_jid = g.jid AND gp.connection_id = g.connection_id
WHERE g.jid IS NULL
UNION ALL
SELECT 'Mídias sem Mensagem' as issue, COUNT(*) as count
FROM message_media mm
LEFT JOIN messages m ON mm.message_db_id = m.id AND mm.connection_id = m.connection_id
WHERE m.id IS NULL;
