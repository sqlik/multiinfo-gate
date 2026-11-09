-- 1.11.4: odbiorcy grupy SMS w trybie osobnych list zapisują się z nazwą, tak jak nadawcy i członkowie.
-- Zapis sprzed 1.11.4 z samymi numerami przechodzi na postać {"phone": …, "name": ""} w tej samej kolejności.
-- Nowa wersja schematu sprawia, że 1.11.3 uruchomione na tej bazie wchodzi w tryb awaryjny, zamiast odrzucać
-- konfigurację grupy z nazwami odbiorców. Data zmiany integracji pozostaje bez zmian.
UPDATE integrations
SET config = json_set(config, '$.recipients', (
  SELECT json_group_array(
    CASE WHEN r.type = 'text' THEN json_object('phone', r.value, 'name', '') ELSE json(r.value) END
    ORDER BY r.key
  )
  FROM json_each(integrations.config, '$.recipients') AS r
))
WHERE kind = 'sms_group' AND json_type(config, '$.recipients') = 'array';
