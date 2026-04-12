-- Estatísticas de Conversas (Mensagens Recebidas vs Enviadas)
-- Fornece um panorama de uso de cada chat.

SELECT 
    c.jid, 
    c.display_name as chat_name,
    COUNT(m.id) as total_msgs,
    SUM(m.from_me) as sent_by_bot,
    SUM(NOT m.from_me) as received_by_bot,
    MAX(FROM_UNIXTIME(m.timestamp)) as last_msg_at
FROM chats c
LEFT JOIN messages m ON c.jid = m.chat_jid AND c.connection_id = m.connection_id
GROUP BY c.jid, c.display_name
HAVING total_msgs > 0
ORDER BY total_msgs DESC;
