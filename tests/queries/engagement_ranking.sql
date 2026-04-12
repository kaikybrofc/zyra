-- Ranking de Engajamento e Identidade
-- Descobre os 10 usuários mais ativos e suas informações básicas.

SELECT 
    u.display_name,
    (SELECT id_value FROM user_identifiers WHERE user_id = u.id AND id_type = 'pn' LIMIT 1) as phone,
    (SELECT id_value FROM user_identifiers WHERE user_id = u.id AND id_type = 'lid' LIMIT 1) as lid,
    COUNT(m.id) as total_messages,
    COUNT(DISTINCT m.chat_jid) as active_chats,
    MAX(FROM_UNIXTIME(m.timestamp)) as last_activity
FROM users u
JOIN messages m ON u.id = m.sender_user_id
WHERE m.connection_id = 'default'
GROUP BY u.id, u.display_name
ORDER BY total_messages DESC
LIMIT 10;
