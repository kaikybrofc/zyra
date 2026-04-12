-- Análise de Custo de Armazenamento por Tipo de Mensagem
-- Útil para monitorar o crescimento do banco de dados.

SELECT 
    content_type,
    COUNT(*) as volume,
    ROUND(SUM(LENGTH(data_json)) / 1024 / 1024, 2) as total_mb,
    ROUND(AVG(LENGTH(data_json)) / 1024, 2) as avg_kb_per_msg,
    ROUND(AVG(JSON_LENGTH(data_json, '$.message')), 1) as avg_json_depth
FROM messages
GROUP BY content_type
ORDER BY total_mb DESC;
