-- Mapa de Calor de Atividade (Hourly Activity Heatmap)
-- Mostra quais as horas de maior pico do bot.

SELECT 
    HOUR(FROM_UNIXTIME(timestamp)) as hour_of_day,
    COUNT(*) as msg_count,
    ROUND(COUNT(*) * 100 / (SELECT COUNT(*) FROM messages), 2) as percentage_of_total
FROM messages
WHERE timestamp > 0
GROUP BY hour_of_day
ORDER BY hour_of_day;
